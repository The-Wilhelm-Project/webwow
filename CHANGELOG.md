# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### CMS: verschachtelte Referenzen bleiben bei ihrem Pfad

- **Referenzketten, die in dieselbe Collection zurückführen, überschreiben das Seitenelement nicht mehr.**
  `resolveReferenceFields` mergte die eigenen Werte jedes referenzierten Elements ins Eltern-Element; bei
  Person → Ort → Ansprechperson zeigte die Detailseite die Felder der Ansprechperson. Übernommen werden jetzt
  nur Werte mit vollem Pfad (`lib/page-fetcher.ts`, Upstream-Bug, [UPSTREAM-SYNC.md](docs/UPSTREAM-SYNC.md) §2a).
- **Referenzauflösung auf höchstens 3 Hops begrenzt**, referenzierte Elemente und Felder pro Request gemerkt:
  dicht verknüpfte Inhalte laufen nicht mehr bei jeder Detailseite durch den ganzen Graphen.

### Webflow-Import: Bildbreite, „Weitere Werke" ohne das aktuelle Werk, Zustände über Chips und unter 480 px

- **Bilder ohne `width` im Export werden nicht mehr gestaucht.** ycode schreibt die Asset-Maße als
  `width`/`height` ans `<img>`; das `width`-Attribut hielt das Hauptbild auf `/werke/<slug>` bei 800 px,
  während `max-height: 70vh` die Höhe kappte (800×630 statt 491×630). Solche Bilder bekommen `w-auto`
  als unterste Framework-Klasse (`html.ts: explicitImageWidth`).
- **„Weitere Werke“ ohne das Werk der Seite.** Zeigt keine gelesene Collection-Seite ihr eigenes Element
  in der Liste der eigenen Collection, bekommt die Liste ycodes Filter „nicht das aktuelle Element“ (`self`/`is_not_one_of`, eigene UND-Gruppe;
  `site-cms.ts: currentItemEvidence`, `WfCollectionBinding.excludeCurrentItem`). Zeigt die Live-Seite die
  auf das aktuelle folgenden Elemente, meldet `collection_guess` das (keine ycode-Einstellung); ohne
  Website meldet es, dass die Liste das aktuelle Element mitzeigt.
- **Zustandsregel auf einer Framework-Klasse schlägt die Chips.** `.w-dropdown-list.w--open` landete in
  den Framework-Klassen unter der Site-Regel von `.w-dropdown-list` und unter dem Chip `.dropdown-list`;
  die offene Liste blieb transparent. Jetzt über der Site-Regel bzw. als One-off-Klassen über den Chips,
  außer wo die Zustandsregel der eigenen Site-Klasse dieselbe Eigenschaft setzt.
- **Zustands-Varianten unter 480 px.** Die abgeleitete Rest-CSS-Regel einer Combo (und jede `tiny`-Regel)
  schlug `current:`/`hover:` der Klasse; deren wirksame Werte stehen jetzt als eigene Rest-CSS-Regeln
  daneben (`html .wf-nav-link.wf-white[aria-current]`, `css.ts: stateTinyOverrides`). Spätere Änderungen
  im Design-Panel erreichen diese abgeleiteten Regeln nicht.

### Webflow-Import: Schrift-Stapel abgesichert, Combo-Vorrang vollständig, Farbe neben Verlauf, Medien in Komponenten, CMS-Listen

- **Sicherheit: Schrift-Fallbacks aus dem Export werden geprüft.** Der Fallback-Stapel eines
  `font-family` landete ungeprüft in der `category` der Schrift und von dort unmaskiert in einem
  `<style>`-Element (`buildFontClassesCss`); ein präpariertes Export-ZIP konnte das Element schließen
  (`"x}</style><img …>"`). Jetzt nur noch Bezeichner oder Namen in Anführungszeichen ohne `< > { } ; \`
  und Zeilenumbruch (`css.ts: safeFontFallback`, erneut in `fonts.ts`), sonst `css_dropped`; ein
  `@font-face` mit solchen Zeichen im Familiennamen wird verworfen (`isSafeFontFamilyName`).
- **Combo-Lift auch für beliebige Eigenschaften, in Kaskaden-Reihenfolge, gegen jede Klasse des
  Elements.** `[border-top-style:solid]` einer Combo wird über die CSS-Longhands verglichen und gegen
  `max-md:[border-top-style:none]` der Basis wiederholt; wiederholte Werte kommen breitester Quelle
  zuerst, sodass `max-lg:pl-[5px]` der Combo das wiederholte `p-[10px]` verfeinert; niedriger ist jetzt
  auch jede weitere Einzelklasse eines Elements, das die Combo trägt (`coOccurringClasses`), auch unter
  480 px (`comboTinyOverrides`).
- **Shorthand der Combo schlägt Longhands der Basis.** `.section.feature { padding: 0 }` verlor ab 992 px
  gegen `pt-[60px] pr-[20px] …` von `.section`; `dropShadowedClasses` entfernt pro Layer jede Klasse,
  deren Eigenschaften eine spätere derselben Variante vollständig setzt.
- **Farbe und Verlauf bleiben beide erhalten.** `background-color: #00000070` neben einem
  `linear-gradient` wird `[background-color:#00000070]`, weil ycodes Merge den Verlauf als Farbe führt
  und die Abdunklung der „Featured painting“ verwarf (`keepColourBesideGradient`,
  `keepBackgroundLayersApart`).
- **Wiederholte Kacheln mit verschiedenen Videos.** Die beiden Video-Kacheln von `/artist` wurden eine
  Komponente mit dem Natur-Video in beiden; jetzt ist das Video (Quelle, Poster, Autoplay/Loop) eine
  `video`-Variable mit Override pro Instanz (`components.ts: componentizeKeepingMedia`, auch Audio und
  Icons). Der Vergleich über Seiten hinweg berücksichtigt das Poster.
- **CMS-Hintergrund auf dem Listen-Element selbst.** Die „Featured painting“ zeigte ycodes
  Platzhalterbild: der Collection-Layer wird zum `display: contents`-Wrapper, das Element mit Hintergrund
  sein Kind (`convert-bridge.ts: liftSelfBoundBackgrounds`).
- **Einträge nur auf der Website bekommen alle Zellen.** „Nur auf der Website“ hatte kein `Order` und
  sortierte als elfter; Listen, die den Eintrag ohne Link zeigen (`/catalog`), füllen jetzt über den
  Namen die restlichen Zellen (`site-cms.ts: liveOnlyRowFor`).
- **Upcoming/Archive.** Zwei Listen, die eine Collection in einer Sortierung aufteilen, werden `limit`
  und `offset` mit gemeinsamer Sortierung (`splitListPairs`); vorher stand KunstSalon in beiden Listen
  und die Galerie Cas Concos (2003) fehlte.

### Webflow-Import: Combo-Vorrang auf allen Breakpoints, Regeln späterer Klassen, Zustände in komplexen Selektoren

- **Eine Combo schlägt ihre Basisklasse auf jedem Breakpoint.** `.section.small { padding: 10px 20px }`
  gewinnt in Webflow gegen jede `.section`-Regel; als Chips gewann `max-lg:p-[50px]` der Basis unter
  992 px, und unter 480 px schlug die Rest-CSS-Regel `html .wf-section { padding: 20px 10px 50px }` die
  Combo-Utilities — die „Current“-Sektion war bei 390 px 1096 statt 1021 px hoch. Der Combo-Chip wiederholt
  seinen Wert jetzt genau auf den Breakpoints, auf denen eine niedrigere Klasse der Kette dieselbe
  Eigenschaft setzt (`liftComboOverBreakpoints`); gegen eine `tiny`-Regel entsteht eine abgeleitete
  Rest-CSS-Regel der Combo mit höherer Spezifität (`comboTinyOverrides`, Grund `combo`). Jetzt 1020,9 px
  (Fixture 1020,9), bei 1440 px 1030,5 (1030,5).
- **Eigenständige Regeln späterer Klassen gelten.** Bei `heading-2 button w-button` kamen nur `.heading-2`
  und die Combo an; `.button` (Rahmen, Radius, `max-width`) fehlte, und bei 390 px war die Schrift 30 statt
  20 px. `html.ts: resolveStyles` legt jede Klasse mit eigener Regel als Chip an, in Stylesheet-Reihenfolge
  (`WfStyleModel.order`), darüber die Combos.
- **Zustandsklassen in komplexen Selektoren** (`.nav .nav-link.w--current`, `.w-locales-item
  a.w--current`, `.dropdown-list.w--open .link`) landeten wörtlich und wirkungslos im Rest-CSS. Jetzt:
  `w--current` → `[aria-current]`; `w--open` / `w--tab-active` einer Dropdown-Liste bzw. eines Tab-Panes
  → Regel ohne Zustandsklasse (Grund `state`; die Klassenlisten aller Elemente liefert
  `states.ts: collectClassLists`); alles andere (Nachfahren eines Toggles, Menü, Element ohne
  Webflow-Zustand) → `css_state_dropped` mit Grund (`css.ts: contextualStateOf`).
- **Zustandsregel auf einer Framework-Klasse** (`.w-dropdown-toggle.w--open`) wird über die
  Framework-Klasse des Elements angewendet (Tween bzw. Merge in die Framework-Klassen) statt still unter einer
  nie gefragten Kette zu liegen; kein leerer Eintrag unter dem Klassennamen mehr.
- **Seiten-Rahmen als Longhands.** `border-top: 1px #000` wird `[border-top-width:1px]
  [border-top-style:none] [border-top-color:#000]`, damit `[border-top-style:solid]` einer Combo den Stil
  verdrängt — die obere Linie der „Current“-Sektion fehlte (0px none statt 1px solid).
- **Schrift-Fallbacks bleiben erhalten.** Der Rest des `font-family`-Stapels (`Arial, sans-serif`) wird die
  `category` der hochgeladenen Schrift, die ycode hinter die Familie schreibt (`WfStyleModel.fontFallbacks`,
  `fonts.ts`).

### Webflow-Import: Dropdowns auf Touch, leere Slots, Body unter 480 px, Menü-Zustand, aktiver Tab

- **Hover-Dropdowns öffnen per Tap.** `webflow.js` behandelt `data-hover="true"` auf Touch-Geräten wie ein
  Klick-Dropdown; der Import ließ die Hover-Interaktion stehen, und der Browser lieferte nach dem Tap
  `mouseenter` + `mouseleave` innerhalb von 32 ms — die Liste ging auf und sofort wieder zu. Die
  Runtime-Zeile (`DROPDOWN_RUNTIME_SCRIPT`) erkennt Touch wie `webflow.js` (`ontouchstart`,
  `DocumentTouch`, dazu `(hover: none)`), schickt dem Wrapper beim Tap das `mouseenter` seiner
  Hover-Interaktion, beim zweiten Tap / Tap außerhalb / Esc / Öffnen eines anderen Dropdowns das
  `mouseleave`, und stoppt das native Paar in der Capture-Phase. Playwright-Prüfung mit `hasTouch` und
  `touchscreen.tap` (`scratchpad/dd/touch-harness.js`, `fix-r1.js`).
- **Leere gebundene Slots verschwinden wie in Webflow.** `components.css` blendet `.w-dyn-bind-empty`
  samt Rändern aus; der Import ließ ein leeres `<p class="mb-[10px]">` stehen und schob den Rich Text der
  „Current“-Einträge 10 px nach unten. Jeder gebundene Slot, der im Export `w-dyn-bind-empty` trug (Text,
  Rich Text, Bild, Hintergrund), bekommt `conditionalVisibility` „Feld vorhanden“ auf seinem Feld
  (`binding.ts: planEmptyValueVisibility`, `convert-bridge.ts`). Item-Links und `__asset_url` bleiben ohne
  Regel; eine `.w-condition-invisible`-Regel hat Vorrang.
- **Body-Klasse unter 480 px.** Die `tiny`-Regel von `.body` (18/20 px statt 24/26 px) lag als
  `html .wf-body { … }` im Rest-CSS, der `<body>` trug aber keinen `wf-body`-Haken. `bodyClassesFor`
  (jetzt in `css.ts`) hängt den Haken an wie bei jedem anderen Layer; auf 390 px sind Body und
  Dropdown-Zeilen jetzt 18 px, das Chevron 18 × 18 wie in der Fixture.
- **Offenes-Menü-Regeln nur auf den eingeklappten Breakpoints.** `.nav-menu[data-nav-menu-open]`,
  `.nav-menu.w--nav-menu-open` und `.nav-menu.w--open` wurden ohne Breakpoint-Präfix in den Basis-Style
  gemerged und hätten die Desktop-Leiste umgebaut (`display`, `background`, `padding`), wo Webflow den
  Zustand nie setzt. `html.ts: applyStateRules` begrenzt sie auf die Collapse-Stufe der Navbar
  (`max-lg:` bei `medium`, `max-md:` bei `small`/`tiny`, ohne Präfix bei `all`; eine schmalere Regel
  behält ihr Präfix); `data-collapse="none"` → `css_state_dropped`.
- **`.tab-link.w--current` wird der Aktiv-Look des Tabs.** Die `current:`-Variante greift nur über
  `aria-current="page"`, das ycode auf Tab-Links nie setzt — der Style ging stumm verloren. `css.ts` merkt
  sich `w--current` auch als Zustandsregel; auf einem Tab-Link wird sie ein Tween auf der Tab-Interaktion
  (`states.ts`, `widgets.ts`: geklickter Tab → Aktiv-Look, alle anderen → Ruhe-Look, der markierte Tab
  startet aktiv; Ruhewert aus den eigenen Klassen, Hintergrund sonst transparent), was nicht tweenbar ist,
  meldet `css_state_dropped` „on the tab link“. Links behalten die `current:`-Variante.

### Webflow-Import: Zustandsklassen (Dropdowns, aktueller Link, Tabs, Menü) und Dropdown-Verhalten

- **`.x.w--open` & Co. werden übersetzt statt als toter Combo-Chip zu landen.** `webflow.js` setzt
  `w--open`, `w--current`, `w--tab-active`, `w--nav-menu-open` erst zur Laufzeit; der Export trägt sie an
  keinem Element, und der Combo-Chip „dropdown-list w--open" griff nie — die geöffnete Liste blieb
  Webflow-grau (`bg-[#ddd]`) statt weiß mit 20 px Innenabstand. Jetzt: Open-Styles einer Dropdown-Liste, eines
  Nav-Menüs (`w--open`, `w--nav-menu-open`, `[data-nav-menu-open]`) oder eines Tab-Panes (`w--tab-active`)
  gehen in den Basis-Style; die Open-Styles eines Toggles / Menü-Buttons werden ein Tween auf derselben
  Klick-/Hover-Interaktion (Hintergrundfarbe, Deckkraft, `transform`, Größe, `display`); `.x.w--current`
  wird ycodes `current:`-Variante (`aria-current="page"`). Was kein Gegenstück hat (Textfarbe im Tween,
  `:hover` auf einer Zustandsklasse, Zustand an einem fremden Element, `tiny`-Breakpoint), meldet die neue
  Warnung `css_state_dropped` mit Selektor und Grund. `states.ts`, `css.ts` (`states`/`resting` im
  Style-Modell), `html.ts: applyStateRules`, `widgets.ts`; Abschnitt „Zustandsklassen" in
  [docs/IMPORTER.md](docs/IMPORTER.md).
- **Hover-Dropdowns öffnen auf dem Wrapper**, nicht auf dem Toggle — wie `webflow.js`
  (`mouseenter`/`mouseleave` auf `.w-dropdown`), damit die Liste offen bleibt, während der Zeiger vom
  Toggle in sie hineinfährt.
- **Klick außerhalb / Esc schließen, `aria-expanded` wird gepflegt.** ycodes Interaktionen haben keinen
  „Klick außerhalb"-Auslöser; eine konstante Runtime-Zeile im Body-Custom-Code (`DROPDOWN_RUNTIME_SCRIPT`,
  wie der Video-Toggle) klickt den Toggle eines offenen Klick-Dropdowns erneut, sodass die yoyo-Timeline
  synchron bleibt; der Wrapper trägt `data-webwow-dropdown`, der Toggle `aria-haspopup`/`aria-expanded`.
- **Verschachtelte Listen ohne Slot bleiben ungebunden.** Die `werke`-Multi-Referenz unter „Upcoming" bekam
  per Heuristik das Bildfeld `images` (`binding_guess 0.80`) und zeigte je Eintrag eine Galerie, wo Webflow
  nichts rendert; jetzt `binding_unbound` mit Klartext (`binding.ts`).
- `server-materializer.ts` enthielt ein rohes NUL-Zeichen (`contentKey`), weshalb git die Datei als
  binär führte; jetzt `\u0000` als Escape-Sequenz.

### Webflow-Import: Rich Text mit Absatzabständen und Tag-Styles (`textStyles`)

- **Rich-Text-Blöcke sehen aus wie in Webflow.** Ein importierter `richText`-Layer rendert `<p>`,
  `<h1>`–`<h6>`, Listen, Zitate, Links und Bilder über `layer.textStyles`; die Tag-Underlays
  (`p { margin: 0 0 10px }` …) erreichten diese Kinder nie, die Absätze klebten aneinander. Jeder
  Rich-Text-Layer bekommt jetzt `textStyles` aus Webflows `normalize.css`/`components.css`, den
  Tag-Regeln der Site und den Nachfahren-Regeln des Containers (`.w-richtext figure`,
  `.rich-text-block p`), mit `design`-Daten fürs Panel; diese Nachfahren-Regeln sind kein Rest-CSS
  mehr. Kein `gap` auf dem Container, die Margins tragen den Abstand.
  `richtext-styles.ts`, `css.ts: richTextDescendantScope / richTextTags`, §2 „Rich Text" in
  `docs/IMPORTER.md`.

### Webflow-Import: Live-Seite — gleichnamige Einträge, Listen auf Collection-Seiten, Jahre in der Site-Zeitzone

- **Zwei gleichnamige Einträge landen nie auf derselben Zeile.** Hatte eine frühere Liste die erste
  Zeile schon gefüllt, passte sie für *beide* gleichnamigen Elemente einer späteren Liste am besten,
  und beide bekamen sie — die zweite Zeile behielt nur ihren Titel (Valeska ohne CSV: „Artbunker
  Grünwald" ohne Jahr und Ort im Archiv). Auf einer statischen Seite werden die Elemente jetzt
  nacheinander vergeben, das sicherste zuerst; vergebene Zeilen fallen für die übrigen weg, auch wenn
  sie deren eindeutig beste wären. `site-cms.ts: assignRows`.
- **Listen auf Collection-Seiten auch ohne CSV/API.** Der Aufbau aus der Website allein hat die Listen
  der `detail_<ordner>`-Seiten übersprungen: „Weitere Werke" zeigte alle 86 Werke statt 4, mit
  geratenen Slot-Bindungen. Sie werden jetzt wie im CSV-Weg über alle gelesenen Seiten zusammengelegt
  (`limit 4 (live site: each of 86 pages shows 4 of 86 Werke items)`, Bindungen mit Konfidenz 1).
  `site-cms.ts: buildSitePlans/noteLiveList/claimItems`.
- **Jahre zählen in der Zeitzone der Site.** Ein Live-`2016` passte zu `Dec 31 2015 23:00 UTC` (2016 in
  Europa) *und* zu `Dec 31 2016 23:00 UTC` (2016 in UTC); zeigte eine Liste nur einen von zwei
  gleichnamigen Einträgen, entschied die CSV-Reihenfolge, die falsche Zeile galt als gezeigt und ein
  dadurch beweisbarer Filter wurde ein Limit. Die Zone, die die CSV-Daten selbst nennen
  (`inferTimeZoneFromDates`), gewichtet jetzt die Datums-Belege: ein Jahr, das nur andere Zonen rendern,
  zählt halb. `site-cms.ts: rowEvidence (OTHER_ZONE_MATCH)`, §4b in `docs/IMPORTER.md`.

### Webflow-Import: gleichnamige CMS-Einträge und Titel der Collection-Seiten aus der Live-Seite

- **Gleichnamige Einträge werden zugeordnet.** Zwei CSV-Zeilen mit demselben Namen (dieselbe Messe in zwei
  Jahren) machten jedes Listen-Element ohne Link zu diesem Namen unauffindbar: keine Zeile, keine
  Werte, keine Bild-Ersatzquelle, kein Zähler für die Collection-Erkennung (Valeska: 7 von 34
  Ausstellungsbildern fehlten, Archive „15 von 22 Elementen"). Jetzt entscheiden die übrigen Werte des
  Elements (Jahr, Ort, Galerie-Bilder; Entwürfe sind keine Kandidaten), danach der Ausschluss auf einer
  statischen Seite, zuletzt die Listenreihenfolge; Bilder eines nicht zuordenbaren Elements werden nach
  Dateiidentität trotzdem Ersatzquelle. Gilt ebenso für Collections, die nur aus der Website gebaut
  werden. `site-cms.ts: assignRows/rowEvidence/identifyItems`, `SiteCollectionBuild.slugsByName`.
- **Collection-Seiten bekommen den Titel der Live-Seite.** Statt des statischen Vorlagen-`<title>` aus
  `detail_werke.html` („valeska von brase") erhält die dynamische Seite den SEO-Titel, den jede gelesene
  Live-Seite zeigt: `<Name> | Valeska von Brase` als Inline-Variable plus Konstante, ebenso die
  Meta-Description, sofern vorhanden. Neuer Hinweis `seo_from_site` (Dialog-Gruppe „Website"); der
  Crawler liest jetzt `<meta name="description">` (`SitePage.description`).
  `site-cms.ts: seoTextTemplate/applySiteSeo`, aufgerufen in `index.ts` nach `importCms`.

### Webflow-Import: Listen-Limits, Datumsfilter und Zeitzone aus der Live-Seite

- **Listen zeigen so viele Elemente wie die Live-Seite.** Zeigt eine Liste auf jeder gelesenen Seite
  dieselbe Zahl n Elemente und hat die Collection mehr, bekommt sie `limit = n` („Weitere Werke" 4 von
  86 statt aller 86, „Current" 2 von 23, „Upcoming" 1, „Archive" 22). Sind die gezeigten Einträge genau
  die mit gesetztem Switch oder mit Datum nach/vor heute, wird stattdessen dieser Filter gesetzt
  (`is true`, `is_after $today`, `is_before $today`) — mit Sortierung nach dem Datumsfeld, sofern kein
  `Order`-Feld sortiert. Paginierte Listen bekommen kein Limit. Jede Entscheidung ist ein
  `collection_guess` („limit 4 (live site: each of 85 pages shows 4 of 86 Werke items)").
  `site-cms.ts: finaliseMerge/listFilterFor`, `binding.ts: BindingOracle.list`, `WfListFilter` in `types.ts`.
- **Jahre stimmen mit der Live-Seite überein.** Das Orakel prüft Datums-Slots jetzt gegen IANA-Zonen
  statt fester Minuten-Offsets und merkt sich, in welchen Zonen der Live-Text zur Zelle passt; die Zone,
  auf die sich alle Slots einigen, wird `settings.timezone` (`Europe/Berlin` am Beispiel: Webflows
  Jahr `2025` liegt in der CSV als `Dec 31 2024 23:00 UTC` und wurde in UTC als `2024` gerendert).
  Ohne Website leiten die Jahr-Daten der CSV die Zone ab (`cms.ts: inferTimeZoneFromDates`). Eine im
  Builder gewählte Zone bleibt. Neuer Hinweis `timezone_set` (Dialog-Gruppe „CMS"), §4b in
  `docs/IMPORTER.md`.

## [1.30.15-webwow.3] - 2026-09-22 — Webflow-artige linke Builder-Sidebar (Rail)

Alle Upstream-Dateien bleiben byte-identisch (`bash scripts/check-upstream-identity.sh`); die Sidebar liegt
vollständig in eigenen Dateien. Bedienung und Details: [docs/BUILDER-SIDEBAR.md](docs/BUILDER-SIDEBAR.md).

### Linke Sidebar nach Webflow-Vorbild — [docs/BUILDER-SIDEBAR.md](docs/BUILDER-SIDEBAR.md)

- **Rail** (48 px Icon-Leiste, `app/(builder)/ycode/components/webwow/`) auf jeder `/ycode`-Route — auch
  neben dem CMS, den Formularen, der Lokalisierung, den Integrationen und den Einstellungen. Items oben:
  Add, Pages, Navigator, Components, Assets, CMS, Forms, Localization, Apps, Settings; unten: Find, Help,
  Profil. Tooltip „Name · Taste", `aria-pressed`, `aria-current` für die aktuelle Route, ein Tab-Stopp mit
  Roving-Tabindex (Pfeiltasten, Home/End — inklusive Profil-Button).
- **Panels** (300 px) direkt neben der Leiste: Navigator (Layer-Baum mit Drag&Drop, Kontextmenü,
  Lock-Anzeige, Komponenten-Varianten), Pages (Seitenbaum mit Ordnern/Settings), Add (die Upstream-
  `ElementLibrary` inline), Components (Instanz einfügen per Klick/Drag, Stift öffnet den Komponenten-
  Editor), Assets (Ordner, Thumbnails, Upload — Klick setzt das Bild auf das gewählte Image-Layer), CMS
  (Collections, „New collection"), Forms, Localization, Apps, Settings, Help (Shortcut-Liste, Doku-Links).
- **Pinnen**: Navigator und Pages lassen sich pinnen (Pin-Icon im Panel-Header); gepinnt schiebt das Panel
  den Canvas nach rechts und ist per Griff zwischen 240 und 480 px breit (Doppelklick = 300 px). Alle
  anderen Panels sind Flyouts über dem Canvas und schließen bei Klick in den Canvas, Esc oder erneutem
  Klick auf das Icon. Default: Navigator gepinnt. Zustand in `localStorage` `webwow.rail.v1`
  (`{ pinned, width }`), jeder Zugriff abgesichert — blockierter Speicher bricht den Builder nicht.
- **Shortcuts** (nur wenn kein Eingabefeld, Select, Popover, Menü oder Dialog fokussiert bzw. offen ist):
  `A` Add, `P` Pages, `Z` Navigator, `Shift+A` Components, `J` Assets, `Esc` schließen (Fokus zurück auf
  das Rail-Icon), `Cmd/Ctrl+K` Find. Die Upstream-Shortcuts bleiben unverändert.
- **Find-Palette** (`Cmd/Ctrl+K`): Seiten, Layer der aktuellen Seite bzw. Komponenten-Variante,
  Collections, Komponenten und Aktionen (Publish, Preview, Panels öffnen/pinnen, Settings, Sign out).
  Publish löst das Window-Event `webwow:publish` aus; die HeaderBar öffnet darauf ihr Publish-Popover.
- **Editor-Rolle** (`?edit`): nur Pages (read-only), Navigator (read-only), Assets, CMS, Help und Profil;
  keine Struktur-Shortcuts.
- **URL-Sync** wie bisher: Pages sichtbar ↔ `/ycode/pages/<id>`, sonst `/ycode/layers/<id>`
  (`history.replaceState`); `activeSidebarTab` im `useEditorStore` bleibt gesetzt, `checkAndCloseSettings()`
  fragt vor dem Ausblenden der Seiteneinstellungen nach.
- **Performance**: `WebwowLeftSidebar`, Rail, Profil-Menü und alle Panels sind memoisiert und erhalten
  stabile Props; der Builder reicht `onLayerSelect`/`onPageSelect` als `useCallback` weiter. Ein Hover im
  Layer-Baum rendert weder die Rail noch versteckte Panels neu; die Find-Palette abonniert die Stores nur,
  solange sie offen ist.
- **Fallback**: `NEXT_PUBLIC_WEBWOW_CLASSIC_SIDEBAR=1` (siehe `.env.example`) mountet wieder die
  Upstream-`LeftSidebar` (Tabs Layers | Pages). `LeftSidebar.tsx` bleibt Upstream-identisch.
- Divergenz-Einträge: `app/(builder)/ycode/components/webwow/**` und `lib/webwow/builder/**` in
  `scripts/sync-lists.sh` (`DIVERGENT_PREFIXES`) und `docs/UPSTREAM-SYNC.md` §2b; `YCodeBuilderMain.tsx`
  (Mount) und `HeaderBar.tsx` (Publish-Event) in §2a. Reine Logik (Items, Rollen, Shortcut-Auflösung,
  Persistenz, Suche) mit node:test-Tests in `lib/webwow/builder/`.

## [1.30.15-webwow.2] - 2026-09-14 — Mehrere Websites, `?edit`-Editor, Webflow-Importer v2

Alle Upstream-Dateien bleiben weiterhin byte-identisch (`bash scripts/check-upstream-identity.sh`).

### Mehrere Websites in einer Installation (optional, `WEBWOW_MULTI_SITE=1`) — [docs/MULTISITE.md](docs/MULTISITE.md)

- **Eine PostgreSQL-Datenbank pro Site** (`webwow_site_<slug>`, `CREATEDB` nötig) neben der bisherigen
  Installation, die zur Default-Site wird. Registry `webwow_sites` in der Haupt-Datenbank (Migration
  `99999999999998_webwow_sites`, seedet die Default-Zeile mit dem vorhandenen `site_name`; in
  Site-Datenbanken ein No-op). Benutzer und Rollen bleiben global.
- **Site-Auflösung im Proxy**: veröffentlichte Seiten und Besucher-Routen (Formulare, Collection-Filter,
  v1-API, MCP) nach Host (Domain → `<slug>.<WEBWOW_SITES_BASE_DOMAIN>` → `<slug>.localhost` → Default),
  Builder/API nach Editor-Pin → Cookie `webwow_site` → Default. Ergebnis ist der HMAC-signierte
  Request-Header `x-webwow-site`; eingehende `x-webwow-*` Header werden verworfen.
- **Site-aware Datenbank-Client** (`knexfile.ts` → `WebwowPgClient`): `getKnexClient()`, `getDb()`,
  PostgREST-Shim und Migrationen arbeiten automatisch auf der Datenbank der aktuellen Site (Pool pro Site,
  LRU-Deckel `WEBWOW_MAX_SITE_POOLS`, Budget-Formel in `.env.example`). Registry/`auth.users` immer über
  `getMainDb()`.
- **Storage**: `UPLOAD_DIR/sites/<id>/<bucket>/…` für weitere Sites, Default-Site unverändert; URLs
  `/storage/v1/object/public/<bucket>/sites/<id>/…`; Upload-Tokens tragen die Site.
- **Cache pro Site**: `next/cache` wird im Server-Bundle durch `lib/webwow/next-cache.ts` ersetzt
  (`unstable_cache`-Keys `site:<id>`, Tags `s-<id>-…`). Nur mit gesetztem Flag — ohne Flag bleiben
  Cache-Schlüssel und statische Seiten byte-identisch. Mit Flag werden veröffentlichte Seiten pro Anfrage
  gerendert; `clearAllCache()` leert das HTML aller Sites (dokumentiert).
- **Dashboard `/webwow`** (eigene Root-Layout-Gruppe `app/(webwow)`, dunkler Builder-Look, Karten wie
  Webflows "All sites"): New site (optional aus `.ycode`-Export), Open, View site, Duplicate (owner),
  Export (.ycode), Settings (Name, Slug, Domains, Editor-Passwort), Delete (mit getippter Bestätigung).
  Login-Formular wie im Builder; Editor-Sessions sehen einen Hinweis.
- **Sites-API** `/ycode/api/webwow/sites/**` (Rollen: auflisten/öffnen jede Session, ändern/löschen/
  importieren/exportieren owner|admin, duplizieren owner; Editor-Sessions 403). Duplizieren kopiert die
  Datenbank per `TEMPLATE` und leert danach Zugangsdaten, Tokens, Webhooks, Formulare, Versionen und die
  Registry in der Kopie; Kopie der Default-Site nur mit Bestätigung (kurze Unterbrechung).
- **CLI** `npm run webwow:sites -- list | migrate | create | delete | set-editor-password`;
  `docker-entrypoint.sh` migriert alle Site-Datenbanken nach `knex migrate:latest`.
- **Proxy-Härtung** (auch im Single-Site-Modus): `/ycode/api/auth/(users|invite|set-role)` verlangen eine
  Session (vorher öffentlich); `POST /ycode/api/setup/migrate` ohne Session läuft immer auf der
  Default-Site; `x-forwarded-host` nur mit `WEBWOW_TRUSTED_PROXY=1`.
- **Neue Variablen**: `WEBWOW_MULTI_SITE`, `WEBWOW_SITES_BASE_DOMAIN`, `WEBWOW_TRUSTED_PROXY`,
  `DB_POOL_MAIN_MAX`, `DB_POOL_SITE_MAX`, `WEBWOW_MAX_SITE_POOLS`; Dockerfile/Compose reichen
  `WEBWOW_MULTI_SITE` als Build-Arg und Env durch. `PAGE_AUTH_SECRET` ist im Multi-Site-Modus Pflicht.
- **Redirect** `/webwow/*` → `/ycode/*` gilt nur noch für alte Builder-Deep-Links; `/webwow`, `/webwow/edit`
  und `/webwow/sites/**` werden ausgeliefert.
- **Sync-Hygiene**: `scripts/sync-lists.sh` (eine Quelle für die Divergenz-Listen),
  `scripts/check-upstream-identity.sh` (schlägt bei ungelisteten Abweichungen fehl),
  `docs/UPSTREAM-SYNC.md` §4e (Cache-Primitive, `headers()` in veröffentlichten Seiten, Routen
  klassifizieren, Next-/knex-Bumps).

### `?edit`-Editor pro Site — [docs/EDITOR.md](docs/EDITOR.md)

- Pro Site ein Editor-Passwort (Dashboard → Settings oder CLI). `https://<domain>/?edit` führt zum
  Editor-Login (`/webwow/edit`); die Session ist per Token an die Site gebunden (12 h) und endet, sobald das
  Passwort geändert oder der Zugang deaktiviert wird.
- Editor-Sessions dürfen nur CMS-Inhalte, Assets, Übersetzungen und Textinhalte von Layern ändern
  (`lib/webwow/proxy-policy.ts`: allow/deny/rewrite pro Route, Enumerations-Test über alle `route.ts`);
  Design, Einstellungen, Benutzer, Integrationen und die Sites-API sind gesperrt.

### Webflow-Importer v2 — jetzt der Importer — [docs/IMPORTER.md](docs/IMPORTER.md)

Der Dialog unter Einstellungen → Templates ruft ab sofort **v2** auf
(`POST /ycode/api/webwow/webflow/import`). v1 (`lib/services/webflowImportService.ts`,
`POST /ycode/api/webflow/import`) bleibt lauffähig, ist aber Legacy und wird von keiner Oberfläche
mehr benutzt.

- **Das Design wird übersetzt statt danebengelegt.** v1 hat das Webflow-Stylesheet wörtlich in
  `settings.custom_code_head` mitgeliefert (92,6 KB) und 658 Layer-Styles **ohne** Design-Daten
  angelegt — das Design-Panel war für jeden importierten Layer leer. v2 legt am Beispiel-Export 119
  Layer-Styles an, **116 davon (97,5 %) mit echten `design`-Daten**; 283 von 338 Layern tragen Design
  (87,1 % ohne Komponenten-Instanzen), und in `layer.classes` steht **kein** roher Webflow-Klassenname
  mehr. Im `custom_code_head` bleiben **5,2 KB** eingegrenztes Rest-CSS ohne `<script>`.
- **Webflow-Klassen werden wiederverwendbare Layer-Styles**, Combo-Klassen ein zweiter Style-Chip
  darüber, Tag-Regeln ein Underlay, `991px`/`767px` die ycode-Breakpoints `medium`/`small`, Hover ein
  `hover:`-Variant. Aus Webflows `normalize.css`/`components.css` (45 KB) werden nur die Tag-Regeln
  übernommen, der Rest verworfen.
- **Wiederkehrende Bereiche werden Komponenten**: 4 Komponenten (Navbar, Footer, fixed-menu_item,
  Div) mit 13 Instanzen. Weicht eine Instanz ab (`navbar black`), bleibt sie inline und wird als
  `component_skipped` gemeldet, statt die Komponente für alle zu verbiegen.
- **CMS**: CSV-Exporte werden Collections mit Feldtypen, Referenzen und Multi-Referenzen; die
  Collection-Listen im HTML werden strukturell gebunden (Sortierung, Limit, „nur veröffentlichte"),
  die Vorlagen-Felder an Text-, Rich-Text-, Bild-, **Hintergrundbild**-, Link- und
  Multi-Asset-Bindungen. Detailseiten binden gegen den aktuellen Eintrag.
- **Verhalten statt Webflow-Skripte**: Menü- und Dropdown-Klicks werden als ycode-Interaktionen
  erzeugt, Webflows IX2-Definitionen ohne `eval` gelesen und auf Animationen abgebildet (9 Hover,
  4 Scroll-into-view, 3 Klick). `webflow.js` und jQuery werden nicht mitgeliefert.
- **Webflow-Widgets werden native ycode-Elemente** (`lib/webwow/import/webflow-zip/widgets-native.ts`):
  `.w-slider` → `slider` mit `slides`/`slide` und den nativen Navigations- und Paginierungs-Layern,
  Einstellungen aus Webflows `data-*` (`data-infinite` → `loop`, Dauer in Sekunden, Effekt, Autoplay,
  Touch); `.w-lightbox` → `lightbox` samt Galerie aus dem `w-json`-Payload, deren Bilder mitgeladen
  und als Assets hinterlegt werden; `.w-form` → `form` mit Formular-Einstellungen, `input` /
  `textarea` / `select` / `option` / Button **mit** `name`, `type`, `placeholder`, `required` … (ohne
  sie käme die Absendung leer an) und `.w-form-done`/`.w-form-fail` als Erfolgs- bzw. Fehlermeldung
  **innerhalb** des Formulars; `.w-tabs` → DOM bleibt, das Umschalten wird wie Navbar und Dropdown als
  Klick-Interaktion erzeugt; `.w-row`/`.w-col-N` → Flex-Row mit echten Spaltenbreiten inklusive der
  `medium`/`small`-Varianten. Jeder Builder ist einzeln abschaltbar (`options.widgets`), und was
  erkannt, aber nicht vollständig abgebildet werden kann, meldet `widget_partial`.
- **CMS-Inhalte wahlweise über die Webflow Data API** (`lib/webwow/import/webflow-zip/data-api.ts`,
  optional). Die CSVs sind reiner Text, der Import muss den Feldtyp aus den Werten erraten; mit einem
  API-Token kommen dieselben Collections typisiert — `Option` samt aller Auswahlmöglichkeiten,
  `MultiImage`, `MultiReference`, `Number`, `Switch`, `Date`/`DateTime`, `RichText` — und mit echten
  Asset-URLs. **Der Token wird nicht gespeichert**: nur für diesen einen Request, in keiner Tabelle,
  keinem Log und keiner Antwort (echot Webflow ihn in einem Fehler, wird er vorher durch `<redacted>`
  ersetzt). Nur lesend, nur vier `GET`-Endpunkte, jede Anfrage durch dieselbe SSRF-Sperre wie jeder
  Asset-Download. Die Site-ID liest der Import aus dem Export (`data-wf-site`). Ohne Token bleibt
  alles wie bisher; beides zusammen geht auch (API gewinnt pro Collection, nur-CSV- und nur-API-
  Collections werden beide importiert und gemeldet). Fehler brechen ab, **bevor** geschrieben wird:
  `webflow_api_unauthorized` (401), `_forbidden` (403, fehlender Scope), `_not_found` (404, Site),
  `_rate_limited` (429, nach mehreren Wartezyklen gemäß `Retry-After`).
- **Rich Text behält seine Auszeichnungen.** Upstreams `htmlToTipTapJSON` entfernt jedes Inline-Tag
  außer `<a>`, sodass `<strong>`, `<em>`, `<u>`, `<s>` und `<code>` als reiner Text ankamen;
  `richtext.ts` läuft über den echten Baum und erzeugt die kanonischen TipTap-Formen
  (`richTextLink`, `richTextImage`) samt Marks.
- **Bekannt, aber nicht vom Importer**: ein importierter Slider wird korrekt als ycode-Slider
  angelegt, schaltet aber nicht weiter — ein von Hand eingesetzter Slider aus der Elementbibliothek
  verhält sich identisch (`syncBullets` in `lib/slider-utils.ts` liest `swiper.el`, bevor es gesetzt
  ist). Und ein Hintergrundvideo zeigt in einem Browser ohne H.264 nur sein Standbild, weil ycode
  eine Datei pro Video speichert und der Import die mp4 behält (`embed_dropped`). Beides steht in
  `docs/IMPORTER.md` § 3a.
- **Jeder Verlust wird gemeldet.** Der Ergebnisdialog zeigt die Zählungen und die Warnungen **nach
  Ursache gruppiert** (CSS ohne Entsprechung, geratene CMS-Zuordnung, Dateien, HTML/Widgets,
  Animationen, Sonstiges) mit einem Satz, was die Gruppe bedeutet. Zwei Optionen im Dialog:
  CDN-Download der CMS-Bilder abschalten und Slug-Kollisionen mit Suffix lösen statt abbrechen.
- **Ein Slug-Konflikt bricht ab, bevor geschrieben wird** (`400 {"code":"slug_conflict"}`); die
  Startseite und die Fehlerseiten der Migration werden wiederverwendet statt dupliziert.
- Neue Module: `server-materializer.ts` (schreibt über die Repositories, nie über HTTP oder Zustand),
  `convert-bridge.ts`, `components.ts`, `pages.ts`, `index.ts` und die Route
  `app/(builder)/ycode/api/webwow/webflow/import/route.ts` (owner|admin, multipart, 300 s).

**Korrekturen dieser Runde**

- **CMS-Hintergrundbilder blieben leer.** Die vier Klassen, die `--bg-img` überhaupt erst anzeigen
  (`bg-cover bg-center bg-no-repeat bg-[image:var(--bg-img)]`), standen nur in `layer.classes` — einem
  abgeleiteten Wert, den ycode aus dem Style-Stack neu berechnet. Sie werden jetzt als Override am
  obersten Style-Chip verankert und überleben jedes Neu-Auffalten; auf der Werk-Seite sind das 85
  Karten, die vorher nichts angezeigt haben.
- **Die zweite Videoquelle verschwand still.** Webflow liefert mp4 und webm, ycode speichert eine
  Datei pro Video. Die mp4 wird behalten, die verworfene webm jetzt als `embed_dropped` gemeldet.

**Website als Quelle, Dialog wie früher, fehlende Widgets**

- **Der Dialog fragt wieder in der alten Reihenfolge**: 1. Website (URL der veröffentlichten Seite,
  optional), 2. Webflow-Export (ZIP, Pflicht, Drop-Zone), 3. CMS-CSV-Dateien (mehrere), 4. Erweitert
  (eingeklappt: API-Token + Site-ID, CDN-Download, Slug-Suffix, ein Schalter je Widget-Builder). Vor
  dem Start steht die Quellen-Zusammenfassung „Design: ZIP · CMS-Daten: API / CSV / Website / keine ·
  Bilder: Website / CDN / Export"; das Ergebnis bekommt eine Zeile „Website" (gelesene Seiten,
  gefüllte Werte, angelegte Einträge, gebundene Slots). Die Formdaten baut
  `lib/webwow/import/webflow-zip/import-form.ts` (getestet).
- **Route**: neues Multipart-Feld `websiteUrl` (nur `http(s)`, kein Benutzername, ≤ 2 KB, Host
  öffentlich — sonst `400 website_invalid`) und `widgets` (JSON, nur bekannte Schlüssel — sonst
  `400 widgets_invalid`).
- **Die veröffentlichte Website ergänzt den Export** (`site-crawl.ts`, `site-cms.ts`, §4b in
  `docs/IMPORTER.md`): gelesen werden die Seiten des Exports, `sitemap.xml`, je Eintrag
  `/<ordner>/<slug>` und die Paginierungsseiten — höchstens 300 Seiten, 4 gleichzeitig, 20 s und
  20 MB je Seite, 200 MB insgesamt, nur `safeFetch`, nur der angegebene Host, Umleitungen nur auf
  denselben Host, kein Cookie, kein Token, kein Skript der Live-Seite. Priorität **Data API > CSV >
  Website**; die Website ersetzt nie einen vorhandenen Wert. Sie füllt leere Zellen
  (`cms_site_value_filled`), legt Einträge an, die nur dort stehen (`cms_site_item_added`), dient als
  Ersatzquelle für CMS-Bilder, deren CDN-Adresse nicht lädt, und baut ohne CSV und API ganze
  Collections je `detail_<ordner>`-Seite (`cms_site_only`). Kein Fehler auf der Website bricht den
  Import ab (`site_unreachable`, `site_page_failed`, `site_page_skipped`); mehrere Sprachen ergeben
  `locales_collapsed`.
- **Binding-Orakel statt Struktur-Raten**: Der Wert jedes Slots im gerenderten `w-dyn-item` wird mit
  den Feldwerten des Eintrags verglichen (Text normalisiert, Bild-Dateiname ohne Id-Präfix, Datum in
  jedem renderbaren Format); passt ein Slot auf genau ein Feld und widerspricht keinem Eintrag, ist
  die Bindung entschieden (Konfidenz 1). Am Beispiel-Export mit Fixture-Live-Seite: `binding_guess`
  58 → 11 (der Rest sind Slots ohne Wert auf der Seite; der `href="#"`-Link eines Elements auf seine
  eigene Seite ist deterministisch und meldet keinen Rat mehr), `collection_guess` mit Konfidenz 1,
  111 CMS-Bilder als Assets, Werk-Kacheln und Detailseiten mit Bild.
- **Fehlende Webflow-Widgets** (`widgets-extra.ts`, Tabelle „Widgets" in `docs/IMPORTER.md`):
  YouTube → `video`-Layer mit Video-ID (Vimeo und `start=` → `iframe`-Layer), Seitenverhältnis aus dem
  Padding-Trick; Lottie → `htmlEmbed` mit `<lottie-player>` und der JSON-Datei als Asset (Player-Zeile
  konstant im Embed, weil ycode Embeds in einem eigenen iframe rendert); Code-Block → `pre` + `code`
  mit unverändertem Text; Datei-Upload → `input[type=file]` + Label (`widget_partial`: ycode speichert
  keine Datei-Uploads); Map → `map`-Layer mit Lat/Lng/Zoom/Stil; Suche → Formular bleibt,
  `widget_unsupported`; Sprachwahl → `localeSelector`; Paginierung → `pagination` des
  Collection-Layers mit Zurück/Weiter und „Seite N von M" (Blättern funktioniert veröffentlicht);
  bedingte Sichtbarkeit → Bedingung „Feld vorhanden" bzw. „Switch ist wahr", sonst `hidden`;
  Play/Pause-Knopf des Hintergrundvideos → `button`-Layer unten rechts plus konstante Runtime-Zeile
  im Body-Custom-Code; Webflow-Icon-Font → Inline-SVG-Icons (Burger, Chevron, Pfeile); Users/Ecommerce
  → normale Formulare mit `widget_unsupported`; Webflow-Badge → entfernt.
- **Navbar-Varianten**: Derselbe Bereich mit anderen Klassen (`navbar` / `navbar black`) wird **eine**
  Komponente mit `variants`; die Instanz der Werk-Detailseite zeigt auf `Black`. Damit sind es am
  Beispiel 3 Komponenten mit 11 Instanzen statt 4 mit 13 (das `fixed-menu_item` steckt jetzt in der
  Navbar-Variante), Layer-Styles 120/117 mit Design, Rest-CSS 5,2 KB, 0 rohe Webflow-Klassen.
- **Neue Warnungscodes**: `site_unreachable`, `site_page_failed`, `site_page_skipped`,
  `cms_site_only`, `cms_site_item_added`, `cms_site_value_filled`, `locales_collapsed`,
  `widget_unsupported` (Dialog-Gruppen „Website" und „HTML/Widgets").
- **Review-Korrekturen an der Website-Quelle**: (1) Antwortet die Adresse mit einer Umleitung auf
  denselben Host mit/ohne `www.`, wird das Ziel geprüft und der Crawl einmal dorthin verlegt
  (`WfSiteCrawl.origin`; `safeFetch` nennt bei einer abgelehnten Umleitung das Ziel) — vorher
  `site_unreachable` trotz richtiger Adresse. (2) Ohne CSV und API bekommt auch eine Liste ohne Link
  auf `/<ordner>/<slug>` Felder und Einträge: Elemente werden über einen Text-Slot mit bekanntem Namen
  (aus den Titeln der Detailseiten) zugeordnet, ein namenloser Rest wird eine eigene Collection
  (Slug aus dem Namen), ein Slot mit den Namen ist das eingebaute `Name`, gleiche Vorlage auf mehreren
  Seiten teilt ihre Slot-Entscheidungen; eine auf der Live-Seite **leere** Liste wird nicht mehr per
  Notlösung an die größte Collection gebunden (`collection_guess` „left unbound"). Am Beispiel-Export
  ohne CSV: `Exhibitions` 23 Einträge mit 5 Feldern, alle Ausstellungslisten an `Exhibitions`
  (Konfidenz 1) statt Werke in der Ausstellungsliste. (3) Nie fatal: `parseSitePage` ist iterativ,
  endet 512 Ebenen tief, wird im Crawl abgefangen (`site_page_failed` „could not parse page"), und um
  den ganzen Website-Schritt liegt ein Sicherheitsnetz (`site_unreachable` statt HTTP 500) — eine
  30 000 Ebenen tiefe Seite bringt weder Parser noch Import zu Fall (Test).
- **Review-Korrekturen an Widgets und CSS**: `.w-dropdown-link` (`10px 20px`, `#222`, Block) und
  `.w-dropdown-toggle` (`20px`, `#222`) tragen Webflows Defaults, das geöffnete Dropdown auf dunkler
  Navbar zeigt keine weißen Links auf weißer Liste mehr; eine eingeklappte Navbar mit Menü-Button
  bekommt für die eingeklappten Breakpoints Webflows Layout des geöffneten Menüs (`absolute top-full
  left-0 right-0 min-w-[200px] bg-[#c8c8c8] text-center` unter `max-lg:`/`max-md:`), sofern die
  Site-Klasse das Menü nicht selbst positioniert (Valeskas `position: fixed`-Menü bleibt unverändert);
  `font-weight: bold|normal|bolder|lighter` wird vor der Übersetzung numerisch (`font-[700]` …) und
  ein trotzdem entstandenes `font-[bold]` repariert — Tailwind v4 las das als Schriftfamilie, die
  Überschriften waren weder fett noch in der richtigen Schrift, das Design-Panel zeigte `bold` als
  Familie (Widgets-Fixture: `h1`/`h2` jetzt `font-weight: 700`, Arial).
- **`safe-fetch.ts`**: `UrlSafetyPolicy` (`allowHttp`, `relaxedHosts`); Hosts aus
  `WEBWOW_IMPORT_ALLOWED_HOSTS` dürfen **außerhalb von `production`** auch über `http` und auf einer
  privaten Adresse liegen — nur für die Verifikation gegen eine lokale Fixture-Seite, die Defaults
  (nur https, nur öffentliche Hosts) sind unverändert.
- **Korrektur**: Der Play/Pause-Knopf des Hintergrundvideos saß nach dem Import oben links im Video,
  weil das Framework-Shim für `.w-background-video--control` leer war; er steht jetzt wie in Webflows
  `components.css` unten rechts (`absolute bottom-[1em] right-[1em]`).

### Nachgezogen aus dem alten Fork (0.9.x) — White-Label und Fehlerkorrekturen

Beim Neuaufbau als Kompatibilitätsschicht wurden alle Upstream-Dateien wieder byte-identisch, wodurch
Anpassungen des alten Forks (ed9d522 → 09bd627) verloren gingen. Sie sind jetzt wieder da; die
betroffenen Upstream-Dateien stehen in `scripts/sync-lists.sh` und sind in
[docs/UPSTREAM-SYNC.md](docs/UPSTREAM-SYNC.md) §2a einzeln mit Re-Apply-Anleitung dokumentiert.

**Fehlerkorrekturen**

- **MCP-`publish` löscht gelöschte Entwürfe jetzt auch veröffentlicht.** Eine über MCP gelöschte Seite
  (ebenso Komponenten, Layer-Styles, Collections) blieb nach `publish` weiter online, weil das
  MCP-Tool die Hard-Delete-Aufräumung der HTTP-Publish-Route nicht mitmachte.
- **Eigene Fehlerseiten funktionieren vor dem ersten Publish.** `/ycode/api/error-page` fällt auf die
  Entwurfsfassung und das Entwurfs-CSS zurück, solange nichts veröffentlicht ist — vorher zeigte eine
  frisch angelegte oder frisch importierte Site keine eigene 401/404/500-Seite.
- **Kein „Loading builder data…"-Blitz mehr.** Der Vollbild-Loader des Builders erscheint nur noch beim
  ersten Kaltstart, nicht bei jedem späteren kurzen `!builderDataPreloaded`.
- **Migrations-Check verschluckt keine HTML-Antwort mehr.** Antwortet ein Proxy oder eine 500-Seite mit
  HTML statt JSON, zeigt der Builder jetzt die Meldung statt `Unexpected token '<'`.

**White-Label**

- **Builder-Tab und PWA**: Titel „Webwow - Visual Website Builder", Favicons, `site.webmanifest`,
  Open-Graph-Bild und `theme-color` sind verdrahtet (die Asset-Dateien lagen bisher unbenutzt in
  `public/`). Bewusst **nur** im Builder-Layout — veröffentlichte Kundenseiten erben weder Favicon
  noch OG-Bild von Webwow.
- **~35 sichtbare „Ycode"-Texte** in Einstellungen, Integrationen (MCP, Webhooks, API, Airtable,
  Webflow, Static Export), OAuth-Zustimmung, HTML-Import, Backup/Restore, Update-Hinweis und im
  KI-Composer heißen jetzt „Webwow". Pfade, DOM-Ids, `ycode://`-URIs, `X-Ycode-*`-Header und die
  Export-Endung `.ycode` bleiben unverändert (Upstream-Kompatibilität).
- **Platzhalterseiten**: „Welcome to Webwow" (Setup-Assistent, leere Entwurfs- und veröffentlichte
  Startseite), „Webwow Preview"; ohne veröffentlichte Inhalte steht im `<title>` nichts mehr von
  „Ycode" / „Built with Ycode".
- **MCP-Tool-Beschreibungen**: Der KI-Assistent stellt sich nicht mehr als „YCode" vor.
- **Layout-Bibliothek**: Die Demo-Texte der Blog-Karten- und FAQ-Layouts warben für Ycode und die
  Header-/Footer-Layouts setzten die `ycode`-Wortmarke ein — beides landete beim Einfügen direkt auf
  der Seite des Nutzers. Texte und `public/ycode/layouts/assets/ycode-logo-black.svg` (gleiches
  132×35-Seitenverhältnis) tragen jetzt die Fork-Marke, ebenso `public/y-filled.svg`.
- **Statischer Export nach GitHub** committet als „Webwow Static Export" statt „Ycode Static Export".
- **„Made in Ycode"-Badge**: Der Code-Default ist jetzt *aus* (`PageRenderer`, `not-found`,
  `error-page`) — bisher hätte ein fehlender oder `NULL`-Wert der Einstellung ihn wieder eingeblendet.
  Der HTML-Kommentar `<!-- Made in Ycode · ycode.com -->` in veröffentlichten Seiten bleibt vorerst
  (Upstream 1.30.x, mit Tests abgesichert; siehe docs/UPSTREAM-SYNC.md §2a).
- **Repo-Doku**: `CONTRIBUTING.md`, `SECURITY.md` und `.cursorrules` sagen jetzt, was hierher gehört
  und was upstream. `LICENSE` und `CODE_OF_CONDUCT.md` bleiben absichtlich die Upstream-Fassung.

**Sonstiges**

- `/dev/css-controls` ist zurück: Entwickler-Sandbox für die Design-Control-Panels ohne Builder und
  ohne Datenbank (in einem Production-Build 404).
- `.gitignore` ignoriert `node_modules` in jedem Verzeichnis, nicht nur im Wurzelverzeichnis —
  sonst landet `tools/vscode-tailwind-class-editor/node_modules/` im Commit.

## [1.30.15-webwow.1] - 2026-09-12 — Upstream-Sync auf ycode 1.30.15

Erster Release der neuen Fork-Strategie. Die Versionsnummer folgt ab jetzt dem Upstream-Schema
`<ycode-Version>-webwow.<n>`. Die Einträge unterhalb dieses Abschnitts sind der unveränderte
Upstream-Changelog von ycode.

### Strategiewechsel: Kompatibilitätsschicht statt Rewrite

- Der alte Fork (0.9.x) hatte ~106 Upstream-Dateien (Repositories, Services, Routen) von Supabase auf
  knex umgeschrieben; jedes Upstream-Update war damit ein manuelles Re-Port.
- Jetzt bleiben **alle Upstream-Dateien byte-identisch**. Nur die Supabase-Nahtstellen
  (`lib/supabase-server.ts`, `lib/supabase-auth.ts`, `lib/supabase-route-client.ts`,
  `lib/supabase-browser.ts`, `lib/credentials.ts`, `knexfile.ts`, `proxy.ts`) werden durch eine
  Kompatibilitätsschicht unter `lib/webwow/**` ersetzt: PostgREST-ähnlicher Query-Builder auf knex,
  Storage auf der lokalen Platte, Auth auf einer eigenen `auth.users`-Tabelle, Realtime als No-op.
- Der Builder-Pfad bleibt intern `/ycode` (kein Verzeichnis-Rename mehr). Dadurch ist
  `git merge upstream/main` künftig nahezu konfliktfrei. Ablauf: `docs/UPSTREAM-SYNC.md`,
  Überblick: `docs/ARCHITECTURE.md`, Helfer: `npm run sync:upstream`.
- Damit kommen alle ycode-Features bis 1.30.15 mit (u. a. AI-Agent mit eigenem API-Key,
  Airtable-/Webflow-App-Integrationen, statischer Export, MCP-Server, globale Variablen,
  Versionen, Layouts).

### Verhaltensänderungen für bestehende Installationen

- **Builder-URL:** `/webwow/...` leitet permanent (308) auf `/ycode/...` um. Lesezeichen und
  Links aktualisieren; alte URLs funktionieren weiter.
- **Login:** statt nur Passwort jetzt **E-Mail + Passwort**. Das Owner-Konto wird beim ersten Start
  aus `ADMIN_EMAIL` (Default `admin@webwow.local`) und `ADMIN_PASSWORD` angelegt; das Env-Passwort
  wird für dieses Konto immer akzeptiert (Recovery). Weitere Benutzer mit Rollen
  (owner/admin/designer/editor) sind möglich, E-Mail-Einladungen (noch) nicht.
  Der Session-Cookie heißt jetzt `webwow_session` (vorher `webwow_admin_auth`) — nach dem Update
  einmal neu anmelden.
- **Uploads:** Ablage jetzt `UPLOAD_DIR/<bucket>/<pfad>` (Bucket `assets`); das alte Layout
  `UPLOAD_DIR/<pfad>` wird als Fallback weiterhin gelesen, ein Umkopieren ist nicht nötig.
  Öffentliche Asset-URLs lauten `/storage/v1/object/public/assets/<pfad>`.
- **Whitelabel:** die Einstellung `ycode_badge` wird jetzt respektiert (Default: aus, per Migration
  `99999999999999_webwow_defaults` gesetzt); ebenso `site_name`/`site_description`, sofern noch auf
  Upstream-Defaults.
- **Datenbank:** vorhandene Daten werden per Migration aufgerüstet — Reihenfolge
  `00000000000000_webwow_bootstrap` (legt Schemata `auth`/`storage`, Rollen und `auth.users` an) →
  alle Upstream-Migrationen bis 1.30.15 → `99999999999999_webwow_defaults`. Der Docker-Container
  führt `knex migrate:latest` bei jedem Start automatisch aus. **Vor dem Update ein `pg_dump`
  ziehen.**
- **Realtime/Presence:** im Single-Server-Modus deaktiviert (No-op-Channel); keine Live-Cursor.
- **Konfiguration:** neue Variablen `ADMIN_EMAIL`, `DATABASE_SSL`; `SUPABASE_*` werden ignoriert.
  `.env.example` ist die Referenz.
- **Docker:** Postgres-Port nur noch auf `127.0.0.1` gebunden; Healthcheck für den App-Container;
  `storage/` (Google-Fonts-Liste, Beispiel-Collections) und `next.config.ts` werden jetzt ins Image
  kopiert; `HUSKY=0` beim `npm ci`; Migrationen mit Retry beim Start.
- **Build/Tooling:** Next 16 (Turbopack), `output: 'standalone'`, Body-Limit 100 MB für den
  Webflow-ZIP-Import; `tools/`, `import/`, `uploads/`, `docs/` sind von tsc/eslint ausgenommen;
  `npm run migrate:*` lädt `.env` automatisch.

## [0.2.0] - 2026-03-03

### Added

- Filter layer with pagination integration for collections
- Dynamic sorting linked to filter form inputs
- Collection-sourced select options for reference field filtering
- Cascading component overrides with enhanced instance management
- Rich-text component overrides and editor UX improvements
- Semantic `<label>` tags for form input wrappers
- Components support in CMS rich-text editor
- Template or blank project choice in welcome flow

### Fixed

- Scope item reorder to draft rows for accurate publish detection
- Clean up soft-deleted entities during publish
- Sort items correctly after drag-and-drop reorder
- Prevent Space key from stealing focus in button text editor
- Resolve QueryBuilder crash in orphaned slug fixer
- Improve audio and video UX settings and component header clickable area in rich-text
- Preload assets in rich-text component overrides
- Improve UX for audio and link override settings in sheets
- Replace sort select with cancel button during linking
- Apply classes on body to prevent inner divs from interfering with styling
- Handle negative values in measurement class generation
- Prevent circular component rendering in LayerRenderer
- Resolve rich-text editor empty state in production and circular rendering via collections
- Harden filter pagination and option loading
- Improve linked filter behavior and picker UI
- Wrap multi-reference filter values in JSON array
- Use OR logic between filter form conditions

### Changed

- Standardize form template input defaults
- Replace sort-by field checkboxes with dropdown
- Update form classes and design data
- Improve line UI and placeholder design settings
- Update multi-reference filtering UI

## [0.1.0] - 2026-02-24

### Added

- Visual drag-and-drop website builder with real-time preview
- Page and folder management with nested routing
- Collections (CMS) with custom fields, items, and dynamic page binding
- CMS item draft/published status with revert-to-published support
- Collection and field deletion protection when in use
- Reusable components with variable support (icon, audio, video overrides)
- Layer styles for consistent design tokens
- Typography controls including body layer support
- Font picker with Google Fonts integration
- Background image support for layers
- Asset management with folder organization and SEO-friendly URLs
- Publishing system with draft/published states
- Password protection for pages and folders
- Localization and translation support
- Form submissions collection
- Template system for importing and exporting site designs
- Keyboard shortcuts for common actions
- Undo/redo support
- SEO settings per page (title, description, OG image)
- Custom code injection (head/body) per page
- Sitemap and robots.txt generation
- API key management for external integrations
- Webhook support for event-driven workflows
- Email integration via SMTP
- Version history tracking
- One-click updates via GitHub fork sync
- Self-hosted on Vercel with Supabase backend
- Row-level security (RLS) policies for improved data isolation
