# Webflow-Import

Im Builder unter **Einstellungen → Templates → „Import Webflow"** — der Dialog in der Reihenfolge des
alten Ablaufs: **1. Website** (URL der veröffentlichten Seite, optional), **2. Webflow-Export (ZIP)**
(Pflicht, Drop-Zone), **3. CMS-CSV-Dateien** (mehrere, optional), **4. Erweitert** (eingeklappt:
Webflow-API-Token und Site-ID, Assets aus dem CDN laden, Slug-Konflikte anhängen, Widget-Schalter).
Vor dem Start steht die Quellen-Zusammenfassung „Design: ZIP · CMS-Daten: API / CSV / Website / keine ·
Bilder: Website / CDN / Export". Was die Website beisteuert, steht in [§4b](#4b-optional-die-veröffentlichte-website-als-quelle).

**Es läuft Importer v2** (`POST /ycode/api/webwow/webflow/import`, Felder `webflowZip`, `csvFiles[]`,
`websiteUrl`, `remoteAssets`, `pageSlugConflict`, `webflowApiToken`, `webflowSiteId`, `widgets`;
`lib/webwow/import/webflow-zip/`). Die alte v1-Route (`POST /ycode/api/webflow/import`,
`lib/services/webflowImportService.ts`) existiert weiter, wird aber **von keiner Oberfläche mehr
aufgerufen** — sie ist Legacy und bleibt nur für Skripte und zum Vergleich stehen, siehe
[§6](#6-legacy-importer-v1).

---

## 1. Der Unterschied zu v1

v1 hat die Seiten aus Webflow übernommen und **Webflows Stylesheet daneben ausgeliefert**: die Layer
trugen die Webflow-Klassennamen, das komplette Original-CSS lag in `settings.custom_code_head`. Die
Seite sah richtig aus, war aber nicht bearbeitbar — das Design-Panel des Builders war für jeden
importierten Layer leer.

v2 **übersetzt** das Design in das native Modell von ycode. Gemessen am Beispiel-Export
(`import/web/valeska-von-brase.webflow.zip` + die beiden CSVs):

| | v1 | **v2** |
| --- | ---: | ---: |
| Layer-Styles angelegt | 658 | 120 |
| davon mit echten Design-Daten | **0** | **117 (97,5 %)** |
| Layer mit Design-Daten | – | 266 von 321 (85,8 % ohne Komponenten-Instanzen) |
| Komponenten | **0** | **3** (Navbar mit den Varianten `Default`/`Black`, Footer, Div) mit 11 Instanzen |
| Interaktionen | einzeln nachgepatcht | 2 IX2-Definitionen → 29 Instanzen (Hover, Scroll-into-view) + 7 erzeugte (Menü, Dropdown, Video-Steuerung) |
| Webflow-CSS wörtlich in `custom_code_head` | **92,6 KB** | **5,2 KB** (71 Regeln, kein `<script>`) |
| rohe Webflow-Klassennamen in `layer.classes` | alle | **0** |
| CMS-Bilder als Assets (mit Website-Adresse, §4b) | – | 111; `binding_guess` 58 → 11 |

Gemessen mit `scratchpad/v2/measure.mts` gegen eine frische Datenbank nach einem Import mit beiden
CSVs und der Website-Adresse der Fixture-Live-Seite. Vor den Komponenten-Varianten waren es 4
Komponenten mit 13 Instanzen: die Navbar der Werk-Detailseite (`navbar black`) blieb inline, und das
`fixed-menu_item` darin wurde als eigene Komponente gezählt — jetzt ist es Teil der Navbar-Variante.

Die 5,2 KB Rest-CSS sind kein Rest-Stylesheet, sondern genau das, was ycodes Modell nicht ausdrücken
kann (§3). Alles andere steht als Tailwind-Utilities in wiederverwendbaren Layer-Styles, die das
Design-Panel liest und schreibt.

---

## 2. Was v2 übersetzt

**Seiten und Struktur**
* Jede `*.html` des Exports wird eine Seite; Titel, Beschreibung, OG-Bild, Canonical, `lang`,
  Favicon und Webclip kommen mit.
* Webflows Collection-Template-Seiten (`detail_*.html`) werden **dynamische Seiten** unter einem
  Ordner (`/werke/*`, `/exhibitions/*`).
* Die Startseite und die Fehlerseiten der Migration werden **wiederverwendet**, nicht dupliziert.
* Kollidiert ein Slug mit einer vorhandenen Seite, bricht der Import ab, **bevor** irgendetwas
  geschrieben wird — oder hängt `-2`, `-3`, … an, wenn „Seiten mit belegtem Slug umbenennen"
  angehakt ist.

**Design**
* Jede Webflow-Klasse wird ein wiederverwendbarer **Layer-Style** mit Tailwind-Klassen *und*
  `design`-Daten, sodass das Design-Panel Werte anzeigt und eine Änderung auf alle Layer mit
  derselben Klasse wirkt.
* **Combo-Klassen** (`.topheader.artist`) werden ein zweiter Style-Chip über dem Basis-Chip, genau
  wie ycode Style-Stacks selbst modelliert.
* **Eigenständige Regeln späterer Klassen**: Trägt ein Element mehrere Klassen (`heading-2 button
  w-button`), gilt im Browser *jede* Einzelklassen-Regel — nicht nur die der ersten. Jede Klasse der Liste
  mit eigener Regel wird ein Chip (`.button` mit Rahmen, Radius, `max-width`), in der Reihenfolge des
  Stylesheets (gleiche Spezifität: die spätere Regel gewinnt, `.heading-2` nach `.button` setzt die
  Schriftstärke), darüber die Combo-Chips (`heading-2 button`). Die Pill-Buttons „Catalog", „All
  Exhibitions" und „The Artist" der Beispiel-Site verloren vorher ihren `.button`-Look.
* **Combo schlägt Basisklasse auf jedem Breakpoint**: In Webflow gewinnt `.section.small { padding: 10px
  20px }` gegen *jede* `.section`-Regel, auch gegen die im 991-px-Block — zwei Klassen schlagen eine.
  Als Chips sind beide gleich schwere Utilities, `max-lg:p-[50px]` der Basis gewönne unter 992 px. Der
  Combo-Chip wiederholt deshalb seinen Wert genau auf den Breakpoints, auf denen eine niedrigere Klasse
  dieselbe Eigenschaft setzt (`max-lg:pt-[10px]` …). Niedriger sind die Klassen der Kette (Basis,
  kürzere Combo) und **jede weitere Einzelklasse eines Elements, das die Combo trägt** (`h l btn` mit
  der Combo `h.l`: die 767-px-Regel von `.btn` ist eine Klasse gegen zwei); welche das sind, liest
  css.ts aus den Klassenlisten des Exports (`coOccurringClasses`). Pro Breakpoint werden die Werte der
  Combo darüber breitester Quelle zuerst wiederholt (Hauptwert, dann `max-lg:`), sodass ein schmalerer
  Longhand (`max-lg:pl-[5px]`) den breiteren Shorthand (`p-[10px]`) verfeinert statt von ihm verdrängt zu
  werden; ein Wert, der einen wiederholten überlappt, wird mitgenommen. Beliebige Eigenschaften
  (`[border-top-style:solid]`) werden über ihre CSS-Longhands verglichen. Unter 480 px gibt es keine
  Stufe: setzt eine niedrigere Klasse dort per `tiny`-Regel dieselbe Eigenschaft (`html .wf-section {
  padding: 20px 10px 50px }`), entsteht eine abgeleitete Rest-CSS-Regel der Combo (`html
  .wf-section.wf-small { padding: 10px 20px }`, eine Klasse mehr, also stärker) mit ihren dort wirksamen
  Werten. Eine eigene `tiny`-Regel der Combo oder eine `!important`-Deklaration der Basis bleibt
  maßgeblich, wie in Webflow. Die „Current"-Sektion der Beispiel-Site war so bei 390 px 7 % zu hoch.
  Dasselbe gilt für die **Zustands-Varianten** einer Klasse oder Combo (`hover:`, `focus:`, `active:`,
  `current:`): Rest-CSS liegt in keinem Layer und schlägt jede Utility, also auch die Variante, während
  in Webflow `.nav-link.white.w--current` (drei Klassen) die `tiny`-Regel von `.nav-link` und die
  abgeleitete Regel der Combo schlägt. Berührt eine `tiny`-Regel darunter (der Klasse selbst, einer
  Klasse der Combo, einer kürzeren Combo oder einer weiteren Klasse ihrer Elemente) eine Eigenschaft,
  die der Zustand setzt, wird dessen wirksamer Wert als eigene Rest-CSS-Regel wiederholt (`html
  .wf-nav-link.wf-white[aria-current] { color: red }`, `html .wf-link:hover { … }` — `w--current` wird
  ycodes `[aria-current]`). **Grenze:** Die abgeleiteten Regeln sind Stand des Imports; ändert man
  später im Design-Panel den Style (Chip, Variante oder One-off-Klasse), erreicht das die abgeleitete
  Regel nicht, unter 480 px gilt dann weiter der importierte Wert. Zustandsregeln, die html.ts in einen
  Chip zusammenführt (`.dropdown-list.w--open`), bekommen keine solche Regel.
* **Shorthand der Combo gegen Longhands der Basis**: `.section.feature { padding: 0 }` (`p-[0]`) über
  `.section`s `pt-[60px] pr-[20px] …` — ycodes Merge behält beide, und in Tailwinds Reihenfolge
  gewinnen die Longhands. Pro Layer fällt deshalb jede Klasse eines Chips weg, deren CSS-Eigenschaften
  eine spätere Klasse derselben Variante vollständig setzt (`dropShadowedClasses`, als Chip-Override
  des Layers; die geteilte Style-Zeile bleibt unverändert). Ein späterer Longhand verdrängt nie einen
  früheren Shorthand.
* **Farbe und Verlauf**: `background-color: #00000070; background-image: linear-gradient(…)` sind in
  CSS zwei Ebenen. ycodes Merge ordnet einen Verlauf aber `backgroundColor` zu und warf die Farbe weg
  (die Abdunklung über dem Bild der „Featured painting" fehlte). Stehen Farbe und Verlauf in derselben
  Variante eines Chips, wird die Farbe zur beliebigen Eigenschaft `[background-color:#00000070]`;
  kommen sie aus verschiedenen Chips (Basis und Combo), wird die Klasse der Combo zu
  `[background-image:…]` bzw. `[background-color:…]`. Das Design-Panel zeigt diese Farbe nicht an.
* **Rahmen einer Seite** (`border-top: 1px #000`) wird in Breite, Stil und Farbe zerlegt
  (`[border-top-width:1px] [border-top-style:none] [border-top-color:#000]`; ausgelassene Teile mit
  ihrem Anfangswert, wie der Shorthand sie zurücksetzt). Als ein einziges `[border-top:…]` gewann der
  Shorthand gegen `[border-top-style:solid]` der Combo (Tailwind sortiert unbekannte Eigenschaften nach
  hinten, und nichts verdrängt eine beliebige Eigenschaft) — die obere Linie der „Current"-Sektion fehlte.
  Einzelne Seiten-Longhands bleiben beliebige Eigenschaften: `border-t-[1px]` schaltete über Tailwinds
  `--tw-border-style` zusätzlich `solid` ein.
* **Schrift-Fallbacks**: Die Klasse trägt die erste Familie (`font-[NeueHaas]`), wie ycode sie für seine
  Schriften erzeugt; der Rest des Stapels (`Arial, sans-serif`) landet in der `category` der
  hochgeladenen Schrift, die ycode hinter die Familie schreibt (`font-family: "NeueHaas", Arial,
  sans-serif`). Gilt für Schriften aus dem Export; Google-Schriften behalten ihre Katalog-Kategorie.
  ycode schreibt die Kategorie unmaskiert in ein `<style>`-Element, deshalb wird ein Stapel nur
  übernommen, wenn jeder Eintrag ein Bezeichner oder ein Name in Anführungszeichen ohne `< > { } ; \`
  und ohne Zeilenumbruch ist (`safeFontFallback`); sonst `css_dropped`. Ein `@font-face` mit einem
  solchen Zeichen (oder Anführungszeichen) im Familiennamen wird ebenfalls verworfen.
* **Breakpoints**: Webflows `991px`/`767px` werden ycodes `medium`/`small` (`max-lg:`/`max-md:`).
* **Schriftschnitte**: `font-weight: bold|normal|bolder|lighter` wird **vor** der Übersetzung zur Zahl
  (`700`/`400`/`700`/`300` → `font-[700]` usw.). Der Upstream-Konverter gäbe `font-[bold]` aus, und
  Tailwind v4 liest ein nicht-numerisches `font-[…]` als Schrift*familie* — Überschriften wären dann
  weder fett noch in der richtigen Schrift, und das Design-Panel zeigte „bold" als Familie. Auch ein
  `font-[bold]`, das der Konverter trotzdem ausgibt, wird repariert (`repairFontWeightClass`).
* **Hover- und Fokus-Zustände** werden Varianten (`hover:`), Tag-Regeln (`h1 { … }`) ein
  Underlay-Style unter der Klasse.
* Webflows eigene `normalize.css` und `components.css` steuern **nur ihre Tag-Regeln** bei — der Rest
  dieser 45 KB wird verworfen statt mitgeliefert.

**Rich Text** (`lib/webwow/import/webflow-zip/richtext-styles.ts`)
* Ein `richText`-Layer rendert seine Blöcke (`<p>`, `<h2>`, `<ul>` …) aus `layer.textStyles`
  (Schlüssel wie `DEFAULT_TEXT_STYLES`: `paragraph`, `h1`–`h6`, `bulletList`, `orderedList`,
  `listItem`, `link`, `bold`, `italic`, `blockquote`, `richTextImage`, `horizontalRule`). Ein
  Tag-Underlay erreicht diese Kinder nicht, denn sie sind keine Layer — ohne Übersetzung stünden die
  Absätze ohne Abstand untereinander (`P:0px`), während Webflow `p { margin: 0 0 10px }` setzt.
* Deshalb bekommt jeder Rich-Text-Layer seine `textStyles` aus den Tag-Regeln (`normalize.css` +
  `components.css` + Site-Sheet: `p` → `paragraph` = `mt-[0] mb-[10px]`, `h1`–`h6` → Größe, Zeilenhöhe,
  Gewicht, Margins, `ul`/`ol` → `pl-[40px]` + Margins, `blockquote` → Padding, Rand, Größe, `a` →
  Farbe, `b`/`strong` → `font-[700]`, `figure`/`img` → `richTextImage`) plus den
  **Nachfahren-Regeln des Containers**: `.w-richtext ol` (`overflow-hidden`), `.w-richtext figure`
  (`max-w-[60%]`), `.w-richtext figure img` (`w-full`) aus `components.css` und Site-Regeln wie
  `.rich-text-block p { … }` oder `.rich-text-block > h2 { … }` — auch mit Breakpoint (`max-lg:`)
  und Zustand (`hover:`). Diese Regeln wandern nicht mehr ins Rest-CSS; die Klasse des Elements
  gewinnt über `.w-richtext`, beide über die Tag-Regel (`css.ts: richTextDescendantScope`,
  `WfStyleModel.richTextTags`; welche Klassen Rich-Text-Container sind, liest `index.ts` vorab aus
  dem HTML). Jeder Eintrag trägt `design`-Daten (`buildDesign`), sodass das Design-Panel die Werte
  für den gewählten Textstil zeigt.
* Was Tailwinds Preflight zurücksetzt und Webflow nie ausspricht, liegt als Grundlinie unter den
  Regeln: `underline` auf Links, `list-disc`/`list-decimal` auf Listen. Ohne irgendeine Regel für
  einen Schlüssel bleibt ycodes Vorgabe stehen (`italic`).
* Der Container bekommt **kein** `flex flex-col gap-[16px]` wie ycodes eigenes Rich-Text-Element:
  die Abstände stecken in den Margins der Blöcke, ein `gap` dazu wäre ein doppelter Abstand. Der
  Inhalt bleibt ein Absatz je `<p>` (`richtext.ts`, auch bei CMS-Werten über `convertValueForFieldType`),
  damit die Margins je Block greifen.
* Grenzen: Regeln unter 480 px (`tiny`) bleiben Rest-CSS (wie überall), ein `border-left` aus
  Webflows `blockquote` wird die Arbitrary-Property `[border-left:5px_solid_#E2E2E2]` (rendert, aber
  ohne Panel-Wert), und ein Bild ist in ycode kein `<figure>` — Margins und `max-width` des
  `figure` liegen darum auf dem Bild selbst.

**Inhalt**
* CSV-Exporte werden **Collections** mit erkannten Feldtypen, Einträgen, Referenzen und
  Multi-Referenzen.
* Collection-Listen im HTML werden an die passende Collection gebunden (inklusive Sortierung, Limit
  und „nur veröffentlichte"-Filter); die Felder im Vorlagen-Element bekommen Feld-Bindungen: Text,
  Rich Text, Bild, **Hintergrundbild**, Link, Multi-Asset-Galerie.
* Detailseiten binden gegen den aktuellen Eintrag (`current-collection`).

**Widgets und Bewegung**
* Navbar: Der Menü-Button bekommt eine **Klick-Interaktion**, die das Menü ein- und ausblendet;
  Dropdowns ebenso (Hover oder Klick, wie in Webflow eingestellt).
* Hintergrundvideo: `<video>` mit `autoplay muted loop playsinline`, Poster, ohne Controls. Webflows
  Play/Pause-Knopf bleibt als `button`-Layer unten rechts im Video-Bereich (`absolute bottom-[1em]
  right-[1em]` aus Webflows `components.css`, siehe Widgets-Tabelle); der Browser ohne H.264 zeigt
  ihn im Zustand „pausiert" mit dem Play-Symbol, weil das Video dort nicht startet (§3a).
* Webflows Interaktionen (IX2) werden ohne `eval` gelesen und auf ycode-Animationen abgebildet —
  Hover-Paare und Scroll-into-view. Bei Scroll-into-view bleibt nur das **Verstecken** (Deckkraft 0)
  als Start-Zustand im CSS der Seite; Skalierung und Verschiebung werden ein **eigener Tween 1 ms
  später** mit `apply_styles: on-trigger`. Grund: ycodes Runtime misst den Auslöser mit GSAPs
  ScrollTrigger am *transformierten* Element — ein auf `scale(0)` geparktes Element ist ein Punkt in
  seiner Mitte, der erst weit unter dem Falz „in den Viewport kommt" und beim Zurückscrollen sofort
  wieder verschwindet (die Werk-Kacheln der Startseite waren bei Scroll 0 unsichtbar). Den
  Start-Zustand malen zwei Stellen vor der Messung: das Seiten-CSS für `on-load` und GSAP selbst,
  weil die Runtime einen Tween an Position 0 mit `immediateRender` anlegt; der Versatz nimmt beiden
  die Geometrie. Unsichtbar ist das Element vor dem Auslösen ohnehin, ein Flackern gibt es nicht.
* **Slider** (`.w-slider`): wird ein echter ycode-Slider — `slider > slides > slide` plus die
  nativen Navigations- und Paginierungs-Layer, die ycode selbst einsetzt. Webflows `data-*`
  steuern die Einstellungen: `data-infinite` → Loop, `data-autoplay` + `data-delay` → Autoplay,
  `data-duration` (ms) → Dauer (s), `data-animation` → Effekt, `data-hide-arrows` → Navigation,
  `data-disable-swipe` → Touch. Webflows eigene Pfeile und Punkte werden verworfen, weil ycode
  sie als Layer neu anlegt.
* **Lightbox** (`.w-lightbox`): wird ein `lightbox`-Layer. Die Galerie steht in Webflows
  `<script class="w-json">`; ihre Bilder werden mitgeladen und als Assets hinterlegt, die
  Gruppe wird als `wf-<name>` übernommen, damit sie nicht mit einer eigenen Gruppe kollidiert.
* **Formular** (`.w-form`): der `<form>` wird ein `form`-Layer mit Formular-Einstellungen, und
  `input` / `textarea` / `select` / `option` / Absende-Button werden die gleichnamigen
  ycode-Layer **mit** `name`, `type`, `placeholder`, `required`, `maxLength` … — ohne diese
  Attribute käme die Absendung leer an. Webflows `.w-form-done` / `.w-form-fail` werden die
  Erfolgs- und Fehler-Meldung **innerhalb** des Formulars (`alertType`), wo ycode sie sucht.
* **Tabs** (`.w-tabs`): ycode hat keinen Tabs-Layer, und `webflow.js` wird nicht mitgeliefert —
  also bekommt jeder `.w-tab-link` eine **Klick-Interaktion**, die sein eigenes `.w-tab-pane`
  zeigt und die anderen ausblendet. Sichtbar bleibt zunächst der Tab, der in Webflow aktiv war.
* **Spalten** (`.w-row` / `.w-col-N`): Webflows 12er-Raster wird ein Flex-Row mit echten
  Spaltenbreiten (`w-[33.333333%]`), inklusive `w-col-medium-*` / `w-col-small-*` als
  `max-lg:` / `max-md:`-Varianten.

Jeder dieser Builder lässt sich einzeln abschalten (`options.widgets`), falls er auf einem
Export etwas verschlechtert; das Widget nimmt dann wieder den alten, generischen Weg.

**Widgets** (`lib/webwow/import/webflow-zip/widgets-extra.ts`, Schalter in `options.widgets`)

Alles, was Webflow außerdem als Widget ausliefert, wird auf das nächstliegende native Element
abgebildet. Was dabei nicht 1:1 geht, steht als `widget_partial` (teilweise) oder
`widget_unsupported` (kein Gegenstück) im Ergebnis.

Die Framework-Klassen bringen dabei Webflows eigene Defaults aus `components.css` mit
(`lib/webwow/import/webflow-zip/framework-classes.ts`), damit ein Element ohne eigene Site-Klasse so
aussieht wie in Webflow: `.w-button` = blau (`#3898ec`), weiß, `9px 15px` Innenabstand, ohne Rahmen;
`.w-nav-button` = `18px` Innenabstand und `24px` Glyphe (der Burger auf dem Handy); `.w-dropdown-toggle`
= `20px` Innenabstand (`40px` rechts für den Chevron) in `#222`, `.w-dropdown-link` = Block mit
`10px 20px` in `#222` (sonst erbte ein Dropdown auf dunkler Navbar die weiße Textfarbe und zeigte weiße
Links auf weißer Liste); `.w-pagination-*` = `1px solid #ccc` mit `2px` Radius. Die Site-Klasse liegt
darüber und gewinnt. **Eingeklapptes Menü:** Ist die Navbar eingeklappt (`data-collapse` ≠ `none`) und
hat einen Menü-Button, bekommt `.w-nav-menu` für die eingeklappten Breakpoints Webflows Layout des
geöffneten Menüs (`absolute top-full left-0 right-0 min-w-[200px] bg-[#c8c8c8] text-center` unter
`max-lg:` bei `medium`, `max-md:` bei `small`/`tiny`, ohne Präfix bei `all`) — das Menü klappt als
Fläche **unter** der Leiste auf statt als schmale Spalte in ihr. Setzt die Site-Klasse selbst eine
Position oder einen Abstand (`position: fixed`, `inset`, `top` …, wie das seitliche Slide-in-Menü des
Beispiel-Exports), bleibt deren Layout unangetastet. Und Webflows
`normalize.css` setzt auf `button`/`img`/`legend` ein `border: 0`, das als `border-0`-Utility in den
Tag-Underlay wandert — ein Rahmen aus der Site-Klasse (`border border-solid border-[#ccc]`) ersetzt
es im Stack, statt dass ein `[border:0]` im Stylesheet über ihm gewinnt.

| Webflow | Markup | Ziel in ycode | Warnung |
| --- | --- | --- | --- |
| Video (YouTube) | `.w-video.w-embed > iframe`, `.w-embed-youtubevideo > iframe` | `video`-Layer mit YouTube-ID (`autoplay`/`mute`/`loop`/`controls` aus der URL); Seitenverhältnis aus dem `padding`-Trick als `aspect-[16/9]` | – |
| Video (Vimeo, YouTube mit `start=`) | dito | `iframe`-Layer mit der bereinigten Player-URL (Parameter bleiben) | – |
| Lottie | `.w-lottie[data-src]` | `htmlEmbed` mit `<lottie-player>`; die JSON-Datei wird Asset. Die Player-Zeile `<script src="https://unpkg.com/@lottiefiles/lottie-player@latest/dist/lottie-player.js">` ist konstant und steht **im Embed**, weil ycode HTML-Embeds in einem eigenen iframe rendert (ein Head-Skript der Seite erreicht das Embed nicht) | `widget_partial`, wenn IX2 die Animation steuert |
| Code Block | `.w-code-block > pre > code.language-*` | `div` mit Tag `pre` + `text`-Layer mit Tag `code`; Text 1:1 (Entities dekodiert, `hljs`-Spans weg, Whitespace erhalten), Sprache als `data-language`, Inline-Styles des Wrappers als Layer-Klassen. ycodes Rich-Text hat keinen `codeBlock`-Knoten, deshalb kein `richText`-Layer | – |
| File Upload | `.w-file-upload` | `input[type=file]` mit `accept`/`multiple` + `label for` im Formular; `-uploading/-success/-error` (webflow.js) entfallen | `widget_partial` „Datei-Uploads werden nicht gespeichert“ (ycode sendet Formulare als JSON) |
| Map | `.w-widget-map[data-widget-*]` | `map`-Layer, Google-Provider, Lat/Lng/Zoom/Stil, Scroll/Touch; Tooltip wird der Suchtext | `widget_partial`: API-Key eintragen; `hybrid`/`terrain` angenähert |
| Search | `form.w-form[action="/search"]` | normales `form`; `search.html` normale Seite | `widget_unsupported` (keine Seitensuche) |
| Locales | `.w-locales-list > … > a[hreflang]` | `localeSelector`-Layer (Label + Chevron); die Link-Liste entfällt | `widget_partial` (aktiv erst mit angelegten Sprachen) |
| Pagination | `.w-pagination-wrapper` in einer `.w-dyn-list` | `variables.collection.pagination` (`pages`, `items_per_page` = Zahl der Vorlagen-Items) + ycodes Zurück/Weiter-Buttons und „Seite N von M“ mit den Texten des Exports; nur das erste Vorlagen-Item wird Collection-Layer | `widget_partial`, wenn die Liste ungebunden bleibt |
| Conditional Visibility | `.w-condition-invisible` | Element mit Feld-Bindung → Bedingung „Feld vorhanden“; statisches Element, dessen Text/Klasse ein Switch-Feld nennt (`Empfohlen`) → „Feld ist wahr“; sonst `hidden` | `widget_partial`, wenn die Regel nicht rekonstruierbar ist |
| Leere Werte | `.w-dyn-bind-empty` an einem gebundenen Slot (Text, Rich Text, Bild, Hintergrund) | Bedingung „Feld vorhanden“ auf dem gebundenen Feld (`binding.ts: planEmptyValueVisibility`): Webflows `components.css` blendet ein leeres gebundenes Element samt Rändern aus (`.w-dyn-bind-empty { display: none !important }`), ycode tut es über `conditionalVisibility` — die leere Beschreibung eines Eintrags schiebt den Rich Text nicht mehr 10 px nach unten. Item-Links und das Pseudo-Feld einer Multi-Bild-Liste (`__asset_url`) haben immer einen Wert und bleiben ohne Regel; eine aus `.w-condition-invisible` rekonstruierte Regel hat Vorrang | – |
| Background-Video-Steuerung | `.w-background-video--control` | `button`-Layer mit Pause-/Play-Icon im Video-Wrapper; konstante Runtime-Zeile im Body-Custom-Code (`data-webwow-video-toggle` → `video.paused ? play() : pause()`, toggelt `w--paused`/`data-paused`); Inhalt im Wrapper (Hero-Text) bleibt erhalten | webm bleibt `embed_dropped` |
| Webflow-Icon-Font | `.w-icon-nav-menu`, `.w-icon-arrow-down`, `.w-icon-slider-*`, `.w-icon-file-upload-*`, `.w-icon-dropdown-toggle` | `icon`-Layer mit Inline-SVG (Burger, Chevrons, Pfeil, X) in `1em`; die Font wird nicht übernommen | – |
| Wiederholte Geschwister mit Medien | gleich gebaute Kacheln, die sich nur in Hintergrund-Video, Audio oder Icon unterscheiden (`/artist`: Natur- und Studio-Video) | ycodes `componentizeLayers` vergleicht nur Text, Bild und Link; `components.ts: componentizeKeepingMedia` lässt es die Medien als Bild-Platzhalter vergleichen und macht daraus danach eine `video`-/`audio`-/`icon`-Variable der Komponente (Video: Quelle, Poster, Autoplay/Loop) mit einem Override pro Instanz. Gleiche Medien bleiben Teil der Vorlage | – |
| CMS-Hintergrund auf dem Listen-Element selbst | `.w-dyn-item` mit gebundenem Hintergrund (`.section.feature`, das Bild des hervorgehobenen Werks) | ycode löst die Feld-Bindungen eines Eintrags nur *innerhalb* des Collection-Layers auf, auf dem Collection-Layer selbst malte es sein Platzhalterbild. `convert-bridge.ts: liftSelfBoundBackgrounds` macht den Collection-Layer zu einem `display: contents`-Wrapper (nur noch Collection-Einstellungen) und verschiebt alles, was das Element trug (Tag, Klassen, Chips samt Overrides, Attribute, Hintergrund-Bindung, Kinder), in ein neues Kind; Interaktionen zielen auf dieses Kind | – |
| Navbar-Varianten | gleicher Bereich, andere Klassen (`navbar` / `navbar black`) | **eine** Komponente mit `variants` (`Default`, `Black`); die Instanz zeigt per `componentVariantId` auf ihre Variante | – (nur noch Links/Struktur-Abweichungen → `component_skipped`) |
| Users / Ecommerce | `.w-users-*`, `.w-commerce-*` | Formulare werden normale `form`-Layer, der Rest Boxen; die Fehler-Boxen, die Webflow mit `style="display:none"` parkt (`Anmeldung fehlgeschlagen.`, `Produkt in dieser Menge nicht verfügbar.`), bleiben über die `hidden`-Utility verborgen — ohne webflow.js zeigt sie niemand | `widget_unsupported` (einmal je Seite) |
| Webflow-Badge | `.w-webflow-badge` | entfernt | – |

**Zustandsklassen** (`lib/webwow/import/webflow-zip/states.ts`)

`webflow.js` setzt zur Laufzeit Zustandsklassen — `w--open` (Dropdown-Toggle und -Liste, Menü-Button),
`w--current` (Link zur aktuellen Seite, aktiver Tab-Link), `w--tab-active` (aktives Tab-Pane),
`w--nav-menu-open` und das Attribut `data-nav-menu-open` (geöffnetes Menü). Der Export trägt sie an keinem
Element, und ycode kennt keinen klassenbasierten Zustand: eine Site-Regel wie `.dropdown-list.w--open
{ background-color: #fff; padding: 20px }` würde als Combo-Chip nie greifen (die geöffnete Liste blieb
Webflow-grau und ohne Innenabstand). `css.ts` merkt sich solche Regeln je Klassenkette ohne die
Zustandsklasse, und `html.ts` übersetzt sie nach der Rolle des Elements:

| Regel | Element | Ziel in ycode |
| --- | --- | --- |
| `.x.w--open` | Dropdown-Liste, Nav-Menü | in den **Basis-Style `x`** (bzw. den Combo-Chip `a b`) gemerged — geschlossen ist die Liste `display: none`, die Open-Styles sind die einzigen, die je sichtbar sind; Breakpoint-Varianten bleiben erhalten (`max-md:p-[10px]`) |
| `.x.w--open` | Dropdown-Toggle, Menü-Button | **Tween auf derselben Klick-/Hover-Interaktion**, die die Liste öffnet: Hintergrundfarbe, Deckkraft, `transform` (`rotate`/`translate`/`scale`/`skew`), Breite/Höhe, `display`; `yoyo` spielt ihn beim Schließen rückwärts. Ausgangswert = die Regeln der eigenen Klasse (`.dropdown-toggle { background-color: #000 }`), sonst ycodes Ruhewert (`rotation 0deg`, `scale 1`, …). Textfarbe, Rahmen, Schrift, Abstände und eine Breakpoint-Regel haben keinen Tween → `css_state_dropped` |
| `.x.w--current` | Link | **`current:`-Variante** im Basis-Style (`current:text-[#0082f3]`, `max-md:current:…`): ycode setzt `aria-current="page"` auf Links zur aktuellen Seite (`@custom-variant current`) |
| `.x.w--current` | Tab-Link | Webflows aktiver Tab; ycode setzt dort kein `aria-current`, also **Tween auf der Tab-Interaktion** (`widgets.ts`): der geklickte Tab bekommt seinen Aktiv-Look, jeder andere gestylte Tab seinen Ruhe-Look (Hintergrundfarbe, Deckkraft, `transform`, Größe; Ruhewert aus den eigenen Klassen, Hintergrund sonst transparent); der im Export markierte Tab startet aktiv. Textfarbe, Rahmen, Schrift und eine Breakpoint-Regel → `css_state_dropped` „on the tab link“. Die `current:`-Variante liegt zusätzlich im Chip und bleibt dort wirkungslos |
| `.x.w--tab-active` | Tab-Pane | Basis-Style (inaktive Panes sind `display: none`) |
| `.x.w--nav-menu-open`, `.x[data-nav-menu-open]`, `.x.w--open` | Nav-Menü | Basis-Style, **auf die eingeklappten Breakpoints der Navbar begrenzt** (`max-lg:` bei `data-collapse="medium"`, `max-md:` bei `small`/`tiny`, ohne Präfix bei `all`; eine Regel auf einem schmaleren Breakpoint behält ihr Präfix): oberhalb des Umbruchs ist das Menü immer sichtbar und `webflow.js` setzt den Zustand dort nie — ein `display`/`background`/`padding` der Open-Regel würde sonst die Desktop-Leiste umbauen. Webflows Fläche unter der Leiste (siehe „Eingeklapptes Menü") liegt darunter, die Site-Regel gewinnt. Bei `data-collapse="none"` gibt es keinen offenen Zustand → `css_state_dropped` |
| `.w-dropdown-toggle.w--open` (Site-Regel auf **einer Framework-Klasse**) | wie oben nach Rolle | Nachschlagen über die Framework-Klasse des Elements: Merge (es gibt keinen Chip), Tween mit Ausgangswerten aus der Site-Regel der Klasse; ein leerer Eintrag unter dem Klassennamen entsteht nicht. Die Regel hat zwei Klassen und schlägt in Webflow jede Ein-Klassen-Regel des Elements: ohne Site-Klasse liegen ihre Klassen deshalb **über** der Site-Regel der Framework-Klasse (`.w-dropdown-list { background: red }`) in den Framework-Klassen, mit Site-Klasse als One-off-Klassen **über** den Chips (`.dropdown-list { background: transparent }`), auf schmaleren Breakpoints wiederholt, wo ein Chip dieselbe Eigenschaft setzt — außer was eine Zustandsregel der eigenen Site-Klasse (`.dropdown-list.w--open`, gleich spezifisch, später im Stylesheet) für dieselbe Variante setzt. Eine Kette aus Site- und Framework-Klassen (`.dropdown-toggle.w-dropdown-toggle.w--open`) → `css_state_dropped` |
| Zustandsklasse an einem anderen Element, kombiniert mit `:hover`, allein (`.w--open`) oder im `tiny`-Breakpoint | – | `css_state_dropped` mit Selektor und Grund; die Regel wird nicht ins Rest-CSS geschoben, wo sie ebenfalls nie träfe |

**Zustandsklassen in komplexen Selektoren** (Nachfahren-/Kind-Ketten, `css.ts` `contextualStateOf`)
werden übersetzt oder gemeldet, nie wörtlich ins Rest-CSS geschoben (ein `.wf-w--open` träfe nichts):

| Regel | Ziel in ycode |
| --- | --- |
| `.nav .nav-link.w--current`, `.w-locales-item a.w--current`, jede Position | Rest-CSS mit ycodes Marker: `.w--current` → `[aria-current]` (`html .wf-nav .wf-nav-link[aria-current]`), jeder Breakpoint inklusive `tiny`. Auf einem Tab-Link setzt ycode kein `aria-current`, dort bleibt die Regel ohne Wirkung |
| `.dropdown-list.w--open .link`, `.tab-pane.w--tab-active > .inner` | Rest-CSS **ohne** die Zustandsklasse, wenn jedes Element des Exports mit diesen Klassen eine Dropdown-Liste bzw. ein Tab-Pane ist (geschlossen/inaktiv `display: none`, der Zustand ist durch die Sichtbarkeit gegeben). Die Klassenlisten aller Elemente sammelt `index.ts` vor dem Stylesheet (`collectClassLists`) |
| `.dropdown-toggle.w--open .icon`, `.w-nav-button.w--open .icon` | `css_state_dropped`: Interaktions-Tweens ändern nur den Toggle selbst, Nachfahren haben keinen offenen Zustand |
| `.navbar.w--open .nav-link` (Element ohne Webflow-Zustand), `.menu[data-nav-menu-open] .link` (Menü öffnet über die Navbar-Interaktion), kein Element mit der Klasse, zwei Zustandsklassen | `css_state_dropped` mit Selektor und Grund |

**Dropdown-Verhalten.** Ein Klick-Dropdown (`data-hover="false"`) bekommt die Klick-Interaktion auf dem
Toggle; ein Hover-Dropdown die Hover-Interaktion auf dem **Wrapper** `.w-dropdown` — wie `webflow.js`
(`mouseenter`/`mouseleave` auf dem Wrapper), damit die Liste offen bleibt, während der Zeiger vom Toggle in
die Liste wandert. Schließen bei Klick außerhalb / Esc und `aria-expanded` kann keine ycode-Interaktion:
`LayerInteraction.trigger` kennt nur `click`, `hover`, `scroll-into-view`, `while-scrolling` und `load`,
keinen „Klick außerhalb". Das übernimmt eine konstante, vom Import verwaltete Runtime-Zeile im
Body-Custom-Code (`DROPDOWN_RUNTIME_SCRIPT`, `<script data-webwow-import="dropdown">`, ~2 KB, dasselbe
Muster wie der Video-Toggle): der Wrapper trägt `data-webwow-dropdown="click|hover"`, der Toggle
`aria-haspopup="menu"` und `aria-expanded`. Ein Klick auf den Toggle wechselt `aria-expanded`; ein Klick
außerhalb eines offenen Klick-Dropdowns, das Öffnen eines anderen oder Esc **klickt dessen Toggle erneut**
— so bleibt die yoyo-Timeline der Interaktion synchron, statt dass ein zweiter Mechanismus die Liste
versteckt; Hover-Dropdowns spiegeln `mouseover`/`mouseout` in `aria-expanded`. **Touch:** `webflow.js`
behandelt ein Hover-Dropdown auf Touch-Geräten wie ein Klick-Dropdown (`hover: data-hover && !touch`,
`touch = 'ontouchstart' in window || DocumentTouch`); die Runtime-Zeile prüft dasselbe (zusätzlich
`matchMedia('(hover: none)')`) und schickt dem Wrapper beim Tap auf den Toggle das `mouseenter`, auf das
seine Hover-Interaktion hört, beim zweiten Tap, einem Tap außerhalb, dem Öffnen eines anderen Dropdowns
oder Esc das `mouseleave`. Das `mouseenter`/`mouseleave`-Paar, das der Browser selbst nach einem Tap
erzeugt (es öffnete und schloss die Liste innerhalb von 32 ms), wird in der Capture-Phase gestoppt, bevor
es den Wrapper erreicht (`ev.isTrusted`, nur an Hover-Wrappern, nur auf Touch). Grenze: Enter/Leertaste
auf dem fokussierten Toggle und `focusout` (beides `webflow.js`) gibt es nicht.

**Dateien**
* Alle im ZIP referenzierten Bilder, Videos, SVGs und Schriftdateien landen in der Asset-Bibliothek
  (Ordner „Webflow import"); Google Fonts werden als Schrift installiert.
* **Bildbreite.** ycode schreibt `width`/`height` aus dem Asset ans `<img>`, wenn der Layer keine hat
  (jedes CMS-Bild, jedes Bild ohne Attribute im Export). Das `width`-Attribut wirkt als `width: <n>px`,
  wo keine Klasse eine Breite setzt; mit `height: 100%; max-height: 70vh` (das Hauptbild auf
  `/werke/<slug>`) wurde das Bild so gestaucht (800×630 statt 491×630). Ein Bild ohne `width`-Attribut
  im Export (oder `width="auto"`) bekommt deshalb `w-auto` als unterste Framework-Klasse — die Breite des
  Originals; jede Breite eines Chips geht vor. Ein `width`-Attribut aus dem Export bleibt, wie es war.
* CMS-Bilder stehen im CSV nur als CDN-Adresse und werden von Webflows CDN nachgeladen (nur HTTPS,
  Host-Allowlist, keine privaten Adressen, Größenbudget). Eine Datei, die die Bibliothek unter
  demselben Namen schon hat, wird wiederverwendet statt erneut geladen.

---

## 3. Was v2 bewusst **nicht** übersetzt

Jeder dieser Fälle erzeugt eine Warnung im Ergebnisdialog. Nichts wird still verworfen.

| Fall | Warnung | Warum |
| --- | --- | --- |
| Webflows viertes Breakpoint `max-width: 479px` | `css_residual … (tiny)` | ycode hat drei Stufen (`main`, `medium` ≤ 991, `small` ≤ 767). Diese Regeln bleiben als eingegrenztes, umbenanntes Rest-CSS erhalten und wirken weiter — im Design-Panel erscheinen sie nicht. Im Beispiel 70 der 71 Rest-Regeln. Auch der `<body>` trägt den `wf-`-Haken seiner Klasse (`wf-body`), wenn deren `tiny`-Regel im Rest-CSS liegt (`html .wf-body { font-size: 18px }` — der Beispiel-Export schaltet den Body unter 480 px von 24/26 auf 18/20 px). Gegen die `tiny`-Regel einer Basisklasse behält eine Combo ihre Werte über eine abgeleitete Rest-CSS-Regel höherer Spezifität (siehe „Combo schlägt Basisklasse" in §2); diese abgeleiteten Regeln zählen nicht als `css_residual`. |
| Pseudo-Element-Regeln (`::after`) | `css_residual … (pseudo)` | ycodes Design-Modell kennt keine Pseudo-Element-Ebene. |
| Vendor-Präfixe (`-webkit-appearance`, `-webkit-backdrop-filter`) | `css_dropped` | Die präfixlose Variante wird übersetzt, die präfixierte verworfen. |
| `filter`-Klassen (`[filter:invert()]`) | – | Die Klasse rendert korrekt, aber `lib/tailwind-class-mapper.ts` hat keine Zuordnung für `filter`, also bleibt das Panel an dieser Stelle leer. Betrifft im Beispiel 3 der 119 Styles. |
| Zweite Videoquelle | `embed_dropped` | Webflow liefert mp4 **und** webm; ycode speichert eine Datei pro Video. Die mp4 wird behalten (breiteste Unterstützung), die webm verworfen. |
| Skripte aus dem Export | `embed_script`, `embed_dropped` | Webflows `webflow.js`, jQuery und die Widget-Skripte werden **nicht** übernommen — ihr Verhalten ist als Interaktion nachgebaut. Eigener Custom-Code bleibt als HTML-Embed-Layer erhalten. |
| IX2-Definitionen ohne Ziel im HTML | `ix2_no_targets` | Im Designer stehengebliebene Interaktionen, deren Ziel-Klassen im Export nicht vorkommen. |
| IX2-Aktionen ohne Gegenstück | `ix2_unsupported_action` | Zum Beispiel Textfarbe animieren: ycodes Tween-Modell kennt `backgroundColor`, aber keine Textfarbe. |
| Bereich, dessen Instanz abweicht | `component_skipped` | Wenn eine Seite denselben Bereich mit anderen **Links oder anderer Struktur** hat, bleibt er **inline**, statt die Komponente für alle zu verbiegen. Weicht nur die Klassenwahl ab (`navbar black`), wird daraus eine Komponenten-Variante (siehe Widgets-Tabelle). |
| Zweiter Schriftschnitt einer Familie | `font_extra_weight` | ycode speichert eine Datei pro Familie; weitere Schnitte bleiben als `@font-face` im Rest-CSS. |
| Leere Vorlagen-Seite | `page_empty` | `detail_exhibitions.html` hat im Export keinen Body — die dynamische Seite entsteht trotzdem, bleibt aber leer. |
| Spaltenbreite unter 480 px (`w-col-tiny-*`) | `widget_partial` | ycode hat für diese Stufe keinen Breakpoint (siehe erste Zeile), die Desktop- und Tablet-Breiten kommen mit. |
| Slider-Einstellung ohne Gegenstück (`data-nav-spacing`, `data-autoplay-limit`) | `widget_partial` | ycodes Slider-Modell kennt sie nicht; alles andere aus Webflows `data-*` wird übernommen. |
| Video in einer Lightbox-Galerie | `widget_partial` | ycodes Lightbox zeigt Bilder. |
| Tab-Link ohne passendes Panel | `widget_partial` | Ohne `data-w-tab`-Partner gibt es nichts zum Umschalten. |
| Zustandsregel ohne Gegenstück (`.dropdown-toggle.w--open { color: #fff }`, `.x.w--open:hover`, `.w--open` allein, `.card.w--open`, `.dropdown-toggle.w--open .icon`) | `css_state_dropped` | ycodes Tween-Modell kennt keine Textfarbe, keinen Rahmen und keine Schrift und tweent nur das Element selbst; eine Zustandsklasse mit `:hover` hat keine Variante; ein Zustand an einem Element, das `webflow.js` nie schaltet, ist tot (siehe „Zustandsklassen" in §2). |

### 3a. Zwei Dinge, die nach dem Import auffallen — und nicht am Import liegen

**Der importierte Slider steht still.** Er wird als echter ycode-Slider angelegt (Swiper-Markup,
`data-slider-initialized`, Slides, Bullets, Pfeile, alle Einstellungen aus Webflows `data-*`), aber er
schaltet nicht weiter, und die Seite meldet
`TypeError: Cannot read properties of undefined (reading 'querySelectorAll')` aus `syncBullets`
(`lib/slider-utils.ts`: `swiper.el` ist im `init`-Handler noch nicht gesetzt). Das ist **kein
Import-Fehler**: ein Slider, der über die Elementbibliothek von Hand eingesetzt wird, verhält sich
Zeichen für Zeichen gleich — gleiche Initialisierung, gleiche Anzahl Slides und Bullets,
`transform: none`, gleiche Fehlermeldung. Betroffen ist jeder Slider im Produkt; die Behebung gehört
in `lib/slider-utils.ts`, nicht in den Importer.

**Das Hero-Video zeigt nur sein Standbild, wenn der Browser kein H.264 kann.** Webflow liefert jedes
Hintergrundvideo doppelt aus (`.mp4` **und** `.webm`), ycode speichert eine Datei pro Video — der
Import behält die mp4 und meldet die webm als `embed_dropped`. In einem Chromium ohne H.264-Decoder
(zum Beispiel dem Playwright-Standardbuild) bleibt deshalb das `poster`-Bild stehen, während das
Original dort auf die webm ausweicht. Layout, Größe, `object-fit: cover`, `autoplay`/`loop`/`muted`
und das Standbild sind in beiden Fällen identisch; wer beide Formate braucht, lädt die webm nach dem
Import als zweites Asset hoch.

---

## 4. Eine falsche Vermutung im Builder korrigieren

Der Import **rät** an mehreren Stellen und sagt jedes Mal, dass er geraten hat (Warnungsgruppe
„CMS-Zuordnung geraten" im Ergebnisdialog). Alles Geratene ist ganz normal editierbar — es gibt keinen
Import-Sonderzustand.

**Falsche Collection an einer Liste** (`collection_guess`)
Layer der Collection-Liste auswählen → rechte Spalte **Settings** → *Collection* umstellen. Sortierung,
Limit und Filter stehen daneben.

**Falsches Feld an einem Text, Bild oder Link** (`binding_guess`)
Den gebundenen Layer auswählen und im Feld-Auswahlfeld das richtige Feld wählen. Bei Hintergrundbildern
sitzt die Bindung unter *Backgrounds → Image*.

**Gar nicht gebunden** (`binding_unbound`)
Eine verschachtelte Liste, deren Vorlage keinen Slot hat (Webflows Multi-Referenz ohne gebundenes Element,
etwa `werke` unter „Upcoming"), bleibt ungebunden und rendert nichts — genau wie Webflow leere Items
rendert; ein geratenes Bildfeld würde dort eine Galerie erfinden. Sonst:
Der Layer zeigt den Text aus dem Export. Layer auswählen → Variable setzen. Betrifft typischerweise
eine zweite Überschrift, die in Webflow auf einen Nachbar-Eintrag zeigte.

**Falscher Feldtyp in der Collection** (`csv_type_guess`)
Passiert bei leeren CSV-Spalten — der Typ kommt dann aus dem Spaltennamen. Unter **CMS → Collection →
Fields** ändern, solange die Spalte leer ist.

**Design stimmt nicht**
Der Layer hat einen oder mehrere Style-Chips (der oberste gewinnt). *Update* ändert den geteilten
Style für alle Layer, die ihn benutzen; *Detach* löst diesen einen Layer heraus. Steht am Chip
**Customized**, hat dieser Layer bereits eine eigene Abweichung.

**Etwas bewegt sich falsch**
Reiter **Interactions** am Layer: Trigger, Tweens und Breakpoints stehen dort und lassen sich ändern
oder löschen. Die vom Import erzeugten Menü- und Dropdown-Klicks sind ganz normale
Klick-Interaktionen.

**Eine Regel wirkt, die nirgends im Panel steht**
Dann kommt sie aus dem Rest-CSS in **Einstellungen → Custom Code → Head** (`<style
id="webwow-webflow-import">`). Der Block ist eingegrenzt (`html .wf-…`) und darf von Hand gekürzt
werden; die `css_residual`-Warnungen sagen, welche Regeln darin stehen.

---

## 4a. Optional: CMS-Inhalte über die Webflow Data API

Die CSVs sind die schwächste Hälfte des Exports: jede Spalte ist Text, also muss der Import den
Feldtyp aus den Werten **erraten** (`csv_type_guess`), eine Auswahlliste ist von freiem Text nicht zu
unterscheiden, und eine leere Spalte trägt überhaupt keinen Typ. Wer einen Webflow-API-Token hat,
kann dieselben Collections stattdessen als typisiertes JSON holen — `MultiImage`, `MultiReference`,
`RichText`, `Option` samt aller Auswahlmöglichkeiten, `Date`/`DateTime`, `Number`, `Switch`.

**Anhaken, Token einfügen, fertig.** Die Site-ID liest der Import aus dem Export (`data-wf-site`);
sie ist nur nötig, wenn der Token auf eine andere Site zeigt. Der Token braucht genau zwei Rechte,
`CMS: read` und `Sites: read` — der Import schreibt nie nach Webflow zurück.

**Der Token wird nicht gespeichert.** Er gilt für genau einen Request: er steht in keiner Tabelle
(die Zeile in `webflow_imports` enthält nur den Dateinamen), in keinem Log und in keiner Antwort.
Taucht er in einer Fehlermeldung von Webflow auf, wird er vor der Weitergabe durch `<redacted>`
ersetzt. Für einen zweiten Import muss er erneut eingefügt werden.

**Ohne Häkchen ändert sich nichts.** Der CSV-Pfad läuft unverändert; beides zusammen geht auch:
Collections, die es in beiden gibt, kommen aus der API, eine Collection nur in den CSVs bleibt beim
CSV-Pfad (gemeldet als `cms_api_partial`), eine Collection nur in der API wird zusätzlich importiert
(gemeldet als `cms_api_extra`). Woher die Inhalte kamen, steht danach im Ergebnis
(„… — aus der Webflow-API").

**Was schiefgehen kann**, meldet der Import mit eigenem Code und bricht ab, *bevor* etwas
geschrieben wird:

| Code | Bedeutung |
| --- | --- |
| `webflow_api_unauthorized` | Token abgelehnt (401) — unvollständig kopiert oder widerrufen. |
| `webflow_api_forbidden` | Token gültig, aber ohne `cms:read`/`sites:read` oder für eine andere Site (403). |
| `webflow_api_not_found` | Site-ID gibt es nicht (404). |
| `webflow_api_rate_limited` | Webflow drosselt (429). Der Import wartet `Retry-After` ab und versucht es bis zu viermal; hält die Drosselung an, bricht er ab. |
| `webflow_api_no_site` | Keine Site-ID eingegeben und keine im Export gefunden. |
| `webflow_api_bad_id` | Eingegebene Site-ID hat nicht die Form einer Webflow-ID. |

Technisch: `lib/webwow/import/webflow-zip/data-api.ts`. Nur `GET`, nur vier Endpunkte, und jede
Anfrage läuft durch dieselbe Sperre wie jeder Asset-Download (`checkUrlSafety` aus `safe-fetch.ts`:
nur https, nur `api.webflow.com`, nur öffentliche Adressen). Die API-Collections werden in genau die
Form gebracht, die `inferSchema` aus einer CSV erzeugt, damit Persistenz, Binding und alles
Nachgelagerte unverändert weiterlaufen und die zwei Quellen nicht auseinanderdriften können.

---

## 4b. Optional: die veröffentlichte Website als Quelle

Der Code-Export ist an drei Stellen leer, wo die veröffentlichte Seite voll ist: jede Collection-Liste
besteht aus **einem** leeren Vorlagen-Element (`w-dyn-bind-empty`), die CMS-Bilder liegen nur als
CDN-Adresse in den CSVs, und die Detailseiten (`/werke/<slug>`) sind leere Hüllen. Wer im Dialog die
**Website** angibt, lässt den Import die Live-Seite lesen (`lib/webwow/import/webflow-zip/site-crawl.ts`,
`site-cms.ts`) und daraus genau das ergänzen:

* **Die exakte Feld-Zuordnung.** Jeder `w-dyn-item`-Klon auf der Live-Seite trägt in jedem Slot
  einen Wert. Der Import vergleicht den Wert jedes Slots mit den Feldwerten des Eintrags (Text
  normalisiert, Bild-Dateiname ohne Webflows Id-Präfix, Datum in jedem Format, das die Seite rendern
  könnte). Passt ein Slot auf **genau ein** Feld und widerspricht keinem Eintrag, ist die Bindung
  entschieden — ohne `binding_guess`, mit Konfidenz 1. Uneindeutige Slots gehen weiter den
  Struktur-Weg aus §4. Auch die Collection einer Liste steht damit fest (`collection_guess` entfällt),
  wenn ihre Einträge auf `/<ordner>/<slug>` verlinken oder einen Namen der Collection zeigen.
  Messbar: die Zahl der `binding_guess`-Hinweise im Ergebnis mit und ohne Website-Adresse.
* **Fehlende Werte.** Eine leere CSV-Zelle, deren Slot auf der Live-Seite einen Wert zeigt, wird
  gefüllt (`cms_site_value_filled`, gezählt pro Feld). Bilder, die die CSV per CDN-Adresse nennt,
  bekommen die Adresse der Live-Seite als **Ersatzquelle**: geladen wird zuerst die CDN-Adresse, die
  Live-Adresse nur, wenn das fehlschlägt (`cms_site_value_filled … statt cdn.prod.website-files.com`).
* **Fehlende Einträge.** Ein Eintrag, der auf der Live-Seite steht, aber in keiner CSV und nicht in
  der API ist, wird angelegt (`cms_site_item_added`): Slug aus dem Link, Name aus dem Slot, der als
  Name erkannt wurde, sonst aus dem `<title>` der Detailseite, die übrigen Zellen aus den Slots, deren
  Feld bekannt ist. Er ist veröffentlicht, denn er *ist* veröffentlicht. Zeigt eine weitere Liste
  denselben Eintrag, ohne ihn zu verlinken (`/catalog` nennt bei jedem Werk `Order: …`), füllt sie
  seine noch leeren Zellen über den Namen, den ihr Name-Slot zeigt (ein Name, den eine CSV-Zeile
  trägt, zählt nicht): ohne `Order` sortierte der Eintrag vorher als elfter statt als letzter.
* **Gleichnamige Einträge.** Webflow erlaubt zwei Einträge mit demselben Namen (dieselbe Messe in zwei
  Jahren, Slug `lucca-art-fair` und `lucca-art-fair-87cdb`). Ein Listen-Element ohne Link zur
  Detailseite, das so einen Namen zeigt, hat mehrere Kandidaten-Zeilen; der Import nimmt die, deren
  übrige Zellen zu den Werten des Elements passen (Jahr, Ort, Bilddateien der verschachtelten
  Galerie), Entwürfe ausgenommen. Ein Jahr zählt dabei nur voll, wenn die Zelle es in der Zeitzone
  der Site rendert (die nennen die CSV-Daten selbst, s. u. „Zeitzone"): Webflows `Dec 31 2015 23:00
  UTC` zeigt in Europa `2016`, `Dec 31 2016 23:00 UTC` nur in UTC — ein Live-`2016` gehört auf einer
  europäischen Site zur ersten Zeile, die zweite passt nur halb. Auf einer statischen Seite erscheint
  jede Zeile höchstens einmal: die Elemente werden nacheinander vergeben, das sicherste zuerst
  (eindeutig beste unter den noch freien Zeilen, höchste Übereinstimmung, dann Listenreihenfolge), die
  schon vergebenen Zeilen fallen für die übrigen weg — zwei Elemente, für die dieselbe Zeile am
  besten passt, landen so auf zwei Zeilen. Bleibt nichts zu unterscheiden, entscheidet zuletzt die
  Listenreihenfolge — beide Zeilen tragen dann ohnehin dieselben Werte. Bilder eines Elements, das
  keiner Zeile zugeordnet werden konnte, werden nach ihrer Dateiidentität trotzdem Ersatzquelle,
  wenn genau eine Zeile der Collection sie nennt (`site-cms.ts: assignRows/rowEvidence`).
* **Titel der Collection-Seiten.** Der Export trägt in `detail_<ordner>.html` nur den statischen
  `<title>` der Vorlage; die Live-Seite rendert pro Eintrag „Affinität | Valeska von Brase". Passt der
  `<title>` jeder gelesenen `/<ordner>/<slug>`-Seite auf `Konstante + Feldwert + Konstante` (Name
  zuerst, dann die Textfelder), bekommt die dynamische Seite genau diese Vorlage als SEO-Titel — das
  Feld als Inline-Variable (`<ycode-inline-variable>`), die der Builder im Titel-Editor zeigt und die
  jede Seite pro Eintrag auflöst. Dasselbe für `<meta name="description">`, wenn die Seiten eine
  haben; ein auf allen Seiten gleicher Text wird als Konstante übernommen. Hinweis `seo_from_site`
  (`site-cms.ts: seoTextTemplate/applySiteSeo`, nach dem Anlegen der Collections, weil die
  Feld-Ids erst dann existieren).
* **Ganze Collections.** Ohne CSV und ohne API baut der Import je `detail_<ordner>`-Seite des Exports
  eine Collection aus der Live-Seite (`cms_site_only`): Einträge = alle gelesenen
  `/<ordner>/<slug>`-Seiten (Name aus dem `<title>`, ohne den Site-Zusatz nach dem letzten `|`/`-`)
  plus alle Listen-Elemente, die auf `/<ordner>/<slug>` verlinken **oder** in einem Text-Slot einen
  Namen zeigen, den die Collection schon kennt (so bekommt auch eine Liste ohne Link — etwa
  Ausstellungen, deren Detailseiten im Export leer sind — ihre Felder und Einträge); die Listen auf
  den Collection-Seiten selbst („Weitere Werke" auf jeder `/werke/<slug>`-Seite) werden dabei wie
  im CSV-Weg über alle gelesenen Seiten zusammengelegt und bekommen so Limit und Slot-Bindungen;
  Felder = die
  Slots der Vorlage, benannt nach ihrer Klasse (`text-block` → `Text Block`, Bilder → `Image`, Rich
  Text → `Rich Text`, sonst `Field n`), typisiert wie eine CSV-Spalte. Ein Slot, der die Namen zeigt,
  ist das eingebaute Feld **Name** (kein Duplikat); zwei Slots mit denselben Werten werden **ein**
  Feld; ein Slot, der auf einer Seite leer ist, übernimmt die Entscheidung derselben Vorlage auf einer
  anderen Seite. Eine Liste, deren Elemente weder verlinken noch einen bekannten Namen zeigen, wird
  eine **eigene** Collection (benannt nach ihrer Wrapper-Klasse, Slug = Name des Elements), damit die
  Liste an *ihre* Einträge gebunden wird und nicht an die größte Collection. Zeigt die Live-Seite eine
  Liste **ohne** Elemente, bleibt sie ungebunden (`collection_guess` „left unbound"), statt per
  Notlösung die größte Collection anzuzeigen. Wer Feldnamen und -typen will, nimmt CSV oder API —
  die Website ist die letzte Stufe.
* **Listen-Einstellungen (Limit und Filter).** Wie viele Elemente eine Liste zeigt, steht im Export
  nicht (ein Vorlagen-Element), auf der Live-Seite schon. Zeigt eine Liste auf **jeder** gelesenen
  Seite dieselbe Zahl n Elemente und hat die Collection mehr, bekommt die Liste `limit = n`
  („Weitere Werke" auf jeder Werk-Seite 4 von 86, „Current" auf der Startseite 2 von 23). Sind
  alle Live-Elemente identifiziert und die gezeigten Einträge **genau** die, bei denen ein Switch
  gesetzt ist oder deren Datum nach bzw. vor heute liegt (Kalendertag in der Site-Zeitzone), wird
  statt des Limits dieser Filter gesetzt (`Switch is true`, `Datum is_after $today` für
  „Upcoming", `is_before $today` für „Archive" — ycodes Datums-Preset, täglich neu ausgewertet);
  ein Datumsfilter sortiert nach seinem Feld (kommende aufsteigend, vergangene absteigend), sofern
  kein `Order`-Feld die Reihenfolge vorgibt. Jede Entscheidung steht als `collection_guess`
  („limit 4 (live site: each of 85 pages shows 4 of 86 Werke items)"). Eine paginierte Live-Liste
  zeigt eine Seitengröße, kein Limit; ein Filter, dessen Bedingung ycode nicht kennt, bleibt ein
  Limit — die Live-Seite ist eine Momentaufnahme.
* **Das aktuelle Element auslassen.** Eine Liste der eigenen Collection auf einer Collection-Seite
  („Weitere Werke" auf `/werke/<slug>`) lässt in Webflow meist das Werk der Seite aus; die Einstellung
  steht nicht im Export. Zeigt keine gelesene Collection-Seite ihr eigenes Element (erkannt an den
  Links `/werke/<slug>` der Einträge), obwohl ein Element mit eigener gelesener Seite in der Liste
  einer anderen vorkommt, bekommt die Liste ycodes Filter „nicht das aktuelle Element" (Bedingung
  `self` / `is_not_one_of` mit dem Element der dynamischen Seite, als eigene UND-Gruppe neben einem
  Feldfilter) und `collection_guess` „leaves out the current Werke item". Zeigt jede Seite die
  Elemente, die in einer festen Reihenfolge auf ihr eigenes folgen (die Beispiel-Site: `/werke/am-start`
  listet `vertikaler-einfall`, `abends-bei-piacenza-um-6`, …, und `/werke/vertikaler-einfall` beginnt
  mit `abends-bei-piacenza-um-6`), meldet ein zweites `collection_guess` „shows the items that follow
  the current one": dafür hat ycode keine Einstellung, die Liste zeigt die ersten n anderen Elemente
  ihrer Sortierung. Ohne Website (oder ohne verwertbare Links) meldet `collection_guess` „lists the
  page's own collection", und die Liste zeigt das aktuelle Element mit.
* **Zwei Listen, die eine Collection teilen.** Zeigen zwei Listen einer Seite dieselbe Collection,
  zusammen genau alle veröffentlichten Einträge, ohne Überschneidung, und liegen die Einträge der
  ersten in einer Datums- oder Zahlensortierung alle vor denen der zweiten (streng, kein Gleichstand
  an der Grenze), bekommt die zweite Liste `offset` = Zahl der Einträge der ersten statt eines
  Limits, und beide Listen diese Sortierung („Upcoming" zeigt die neueste Ausstellung mit `limit 1`,
  „Archive" `offset 1`, beide `datum` absteigend; `collection_guess … offset 1 (…)`). Mit zwei
  Limits stand die neueste Ausstellung in beiden Listen, und die älteste fehlte. Passt ein
  Datumsfilter relativ zu heute, hat er Vorrang (siehe oben).
* **Zeitzone.** Webflow rendert Daten in der Zeitzone der Site; ycode in `settings.timezone`
  (Standard UTC). Ein Datums-Slot, dessen Live-Text zur Zelle nur in bestimmten Zonen passt (das
  Webflow-Jahr `2025` steht in der CSV als `Dec 31 2024 23:00 UTC` — in UTC wäre das `2024`), nennt
  die Zonen, die die Seite reproduzieren (`UTC`, `Europe/London`, `Europe/Berlin`,
  `Europe/Helsinki`, die vier US-Zonen — IANA-Namen, damit Sommer- und Winterdaten wie auf der Seite
  fallen). Die Zone, auf die sich alle Datums-Slots einigen, wird `settings.timezone`
  (`timezone_set`), sofern dort noch der Standard steht; eine gewählte Zone bleibt. Ohne Website
  entscheiden die CSV-Daten selbst: Webflow speichert ein gewähltes Jahr als lokale Mitternacht des
  1. Januar, `Dec 31 23:00 UTC` heißt also UTC+1 (`Europe/Berlin`), `22:00` UTC+2
  (`Europe/Helsinki`), `Jan 1 00:00` UTC.

**Priorität:** Data API > CSV > Website. Die Website ersetzt nie einen vorhandenen Wert.

**Was gelesen wird:** die Seiten des Exports (`index.html` → `/`, `work.html` → `/work`), die
`sitemap.xml` (nur derselbe Host, auch Sitemap-Indizes), pro Collection eine Seite je Eintrag
(`/<ordner>/<slug>` aus CSV / API, sonst aus den Links der Live-Seite), Paginierungsseiten
(`?<listId>_page=N`, ihre Einträge werden an die Liste gehängt), `<link rel="canonical">` und
`hreflang`-Alternativen. Mehrere Sprachen auf der Live-Seite ergeben `locales_collapsed` — der Import
übernimmt eine.

**Umleitung auf `www.`:** Antwortet die angegebene Adresse mit einer Umleitung auf denselben Host mit
oder ohne führendes `www.` (`example.com` → `www.example.com` oder umgekehrt), wird das Ziel wie die
Eingabe geprüft und der Crawl **einmal** dorthin verlegt; danach gilt wieder nur dieser Host. Jede
andere Umleitung auf einen fremden Host bleibt `site_unreachable`.

**Grenzen:** höchstens 300 Seiten, 4 gleichzeitig, 20 s je Seite, 20 MB je Seite, 200 MB insgesamt,
**120 s für den ganzen Crawl** (die Import-Route darf 300 s laufen; jede Seite bekommt höchstens die
Restzeit als eigenen Timeout). Das Byte-Budget zählt beim Streamen mit — auch eine Antwort ohne
`Content-Length` lädt nie mehr als das Budget noch hergibt — und sobald es erschöpft ist, wird keine
weitere Seite mehr angefragt. Jede erreichte Grenze steht **einmal** im Ergebnis
(`site_page_skipped` mit der Zahl der ungelesenen Seiten), nicht als eine Meldung je Seite.
Nichts davon bricht den Import ab: die Website ist eine Ergänzung, und jedes Problem ist ein Hinweis.
Das gilt auch für krankhaft verschachteltes Markup: jeder Gang durch eine Live-Seite ist iterativ und
endet 512 Ebenen tief (tiefere Teilbäume werden übersprungen); eine Seite, die der Parser trotzdem
nicht verdaut, zählt als `site_page_failed` („could not parse page"), und ein Sicherheitsnetz um den
ganzen Website-Schritt macht aus jedem unerwarteten Fehler ein `site_unreachable` — nie ein HTTP 500.

| Code | Bedeutung |
| --- | --- |
| `site_unreachable` | Die Startseite antwortete nicht (oder die Adresse wurde vom Server abgelehnt, oder der Website-Schritt ist unerwartet gescheitert). Der Import läuft ohne Website weiter. |
| `site_page_failed` | Eine Seite antwortete nicht mit 200 (Timeout, 404, zu groß, Umleitung auf einen fremden Host) oder ließ sich nicht parsen. |
| `site_page_skipped` | Seitenlimit, Byte-Budget oder Zeitbudget erreicht (einmal, mit Zähler), oder die Antwort war kein HTML. |
| `cms_site_only` | Collection ohne CSV und API komplett aus der Website aufgebaut. |
| `cms_site_item_added` | Eintrag nur auf der Website gefunden und angelegt. |
| `cms_site_value_filled` | Leere Zelle aus der Website gefüllt, oder ein CMS-Bild von der Website statt vom CDN geladen. |
| `seo_from_site` | SEO-Titel / Meta-Description einer dynamischen Seite aus den `<title>`/`<meta>` der Live-Collection-Seiten (Feld als Inline-Variable plus Konstante). |
| `locales_collapsed` | Die Website hat mehrere Sprachen (`hreflang`); der Import kennt nur eine. |
| `timezone_set` | `settings.timezone` aus den Datums-Slots der Website bzw. den Jahr-Daten der CSV gesetzt (oder: bliebe wie konfiguriert, mit der Zone, die die Daten nahelegen). |

**Sicherheit:** Die Adresse wird serverseitig geprüft, bevor irgendetwas geschieht (nur `http(s)`,
kein Benutzername im URL, höchstens 2 KB, **nur der Standard-Port** 80/443 — eine veröffentlichte
Seite hat keinen anderen, und ein freier Port machte den Crawl zum Port-Scanner —, Host öffentlich —
sonst `400 website_invalid`). Jede Seite wird über `safeFetch` geladen: nur der angegebene Host,
Umleitungen nur auf denselben Host, kein Cookie, kein Token, keine Kopfzeile außer `accept`. **Die
Verbindung geht an genau die Adresse, die die Prüfung gesehen hat:** `safeFetch` löst den Hostnamen
einmal auf, prüft jede Adresse und öffnet den Socket über Nodes `http(s)`-Client mit dieser Adresse
(`Host` und TLS-Servername bleiben der Hostname). Ein DNS-Name, der beim zweiten Auflösen auf
`127.0.0.1` oder `169.254.169.254` zeigt (Rebinding), erreicht so nichts — auch nicht über eine
Umleitung, denn jeder Sprung wird neu geprüft und neu festgenagelt. Kein Skript der Live-Seite wird
gelesen oder übernommen — die Regel für Skripte aus §3 (`embed_script`) gilt unverändert. Ein Host aus
`WEBWOW_IMPORT_ALLOWED_HOSTS` darf außerhalb von `production` auch über `http`, auf einer privaten
Adresse und auf einem anderen Port liegen; das ist die Verifikations-Umgebung mit einer lokalen
Fixture-Seite, nie ein Default — `safeFetch` selbst lockert nichts, der Crawler und der CMS-Bild-Download
übergeben die Liste ausdrücklich (`envRelaxedHosts()`, in `production` immer leer).

---

## 5. Grenze des Exports

Ein Webflow-Code-Export enthält **keine CMS-Inhalte**: jede Collection-Liste besteht nur aus einem
leeren Vorlagen-Element, und die Bilder der Einträge stehen ausschließlich als CDN-Adressen in den
CSV-Dateien. Deshalb sieht die importierte Seite an diesen Stellen *voller* aus als der Export selbst
— der Export zeigt „No items found", der Import die echten Einträge. Mit der Website-Adresse (§4b)
holt der Import die gerenderten Werte, die Bilder und die Detailseiten von der veröffentlichten Seite.

Mit einem API-Token (§ 4a) kommen die Bilder als echte Asset-URLs statt als semikolongetrennte
CSV-Spalte — heruntergeladen werden sie über denselben Weg.

Kann der Server Webflows CDN nicht erreichen, bleiben die Bildfelder leer und die Seite rendert den
Platzhalter von ycode. Das Häkchen „CMS-Bilder von Webflows CDN laden" auszuschalten macht den Import
in dem Fall deutlich schneller; die Bilder lassen sich später in die Asset-Bibliothek laden und an den
Feldern setzen.

---

## 6. Legacy: Importer v1

`lib/services/webflowImportService.ts` + `app/(builder)/ycode/api/webflow/**`. Unverändert lauffähig
unter `POST /ycode/api/webflow/import`, aber **nicht mehr verdrahtet**: der Dialog ruft v2 auf.

v1 bleibt vorerst stehen, weil er eine andere Wette eingeht — Original-CSS mitliefern statt
übersetzen — und damit als Vergleichsmaßstab für die Pixel-Treue taugt. Für neue Importe gibt es
keinen Grund mehr, ihn zu benutzen: die Seiten sind danach nicht bearbeitbar.
