# Webflow-Import

Im Builder unter **Einstellungen → Templates → „Import Webflow"**: Webflow-Export-ZIP hochladen,
optional die CMS-CSV-Dateien dazu.

**Es läuft Importer v2** (`POST /ycode/api/webwow/webflow/import`,
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
| Layer-Styles angelegt | 658 | 119 |
| davon mit echten Design-Daten | **0** | **116 (97,5 %)** |
| Layer mit Design-Daten | – | 283 von 338 (87,1 % ohne Komponenten-Instanzen) |
| Komponenten | **0** | **4** (Navbar, Footer, fixed-menu_item, Div) mit 13 Instanzen |
| Interaktionen | einzeln nachgepatcht | 16 (9 Hover, 4 Scroll-into-view, 3 Klick) |
| Webflow-CSS wörtlich in `custom_code_head` | **92,6 KB** | **5,2 KB** (71 Regeln, kein `<script>`) |
| rohe Webflow-Klassennamen in `layer.classes` | alle | **0** |

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
* **Breakpoints**: Webflows `991px`/`767px` werden ycodes `medium`/`small` (`max-lg:`/`max-md:`).
* **Hover- und Fokus-Zustände** werden Varianten (`hover:`), Tag-Regeln (`h1 { … }`) ein
  Underlay-Style unter der Klasse.
* Webflows eigene `normalize.css` und `components.css` steuern **nur ihre Tag-Regeln** bei — der Rest
  dieser 45 KB wird verworfen statt mitgeliefert.

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
* Hintergrundvideo: `<video>` mit `autoplay muted loop playsinline`, Poster, ohne Controls.
* Webflows Interaktionen (IX2) werden ohne `eval` gelesen und auf ycode-Animationen abgebildet —
  Hover-Paare und Scroll-into-view.
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

**Dateien**
* Alle im ZIP referenzierten Bilder, Videos, SVGs und Schriftdateien landen in der Asset-Bibliothek
  (Ordner „Webflow import"); Google Fonts werden als Schrift installiert.
* CMS-Bilder stehen im CSV nur als CDN-Adresse und werden von Webflows CDN nachgeladen (nur HTTPS,
  Host-Allowlist, keine privaten Adressen, Größenbudget). Eine Datei, die die Bibliothek unter
  demselben Namen schon hat, wird wiederverwendet statt erneut geladen.

---

## 3. Was v2 bewusst **nicht** übersetzt

Jeder dieser Fälle erzeugt eine Warnung im Ergebnisdialog. Nichts wird still verworfen.

| Fall | Warnung | Warum |
| --- | --- | --- |
| Webflows viertes Breakpoint `max-width: 479px` | `css_residual … (tiny)` | ycode hat drei Stufen (`main`, `medium` ≤ 991, `small` ≤ 767). Diese Regeln bleiben als eingegrenztes, umbenanntes Rest-CSS erhalten und wirken weiter — im Design-Panel erscheinen sie nicht. Im Beispiel 70 der 71 Rest-Regeln. |
| Pseudo-Element-Regeln (`::after`) | `css_residual … (pseudo)` | ycodes Design-Modell kennt keine Pseudo-Element-Ebene. |
| Vendor-Präfixe (`-webkit-appearance`, `-webkit-backdrop-filter`) | `css_dropped` | Die präfixlose Variante wird übersetzt, die präfixierte verworfen. |
| `filter`-Klassen (`[filter:invert()]`) | – | Die Klasse rendert korrekt, aber `lib/tailwind-class-mapper.ts` hat keine Zuordnung für `filter`, also bleibt das Panel an dieser Stelle leer. Betrifft im Beispiel 3 der 119 Styles. |
| Zweite Videoquelle | `embed_dropped` | Webflow liefert mp4 **und** webm; ycode speichert eine Datei pro Video. Die mp4 wird behalten (breiteste Unterstützung), die webm verworfen. |
| Skripte aus dem Export | `embed_script`, `embed_dropped` | Webflows `webflow.js`, jQuery und die Widget-Skripte werden **nicht** übernommen — ihr Verhalten ist als Interaktion nachgebaut. Eigener Custom-Code bleibt als HTML-Embed-Layer erhalten. |
| IX2-Definitionen ohne Ziel im HTML | `ix2_no_targets` | Im Designer stehengebliebene Interaktionen, deren Ziel-Klassen im Export nicht vorkommen. |
| IX2-Aktionen ohne Gegenstück | `ix2_unsupported_action` | Zum Beispiel Textfarbe animieren: ycodes Tween-Modell kennt `backgroundColor`, aber keine Textfarbe. |
| Bereich, dessen Instanz abweicht | `component_skipped` | Wenn eine Seite denselben Bereich mit anderen Klassen oder Links hat (`navbar black`), bleibt er **inline**, statt die Komponente für alle zu verbiegen. Der richtige Ort dafür wäre eine Komponenten-Variante — die legt der Import nicht selbst an. |
| Zweiter Schriftschnitt einer Familie | `font_extra_weight` | ycode speichert eine Datei pro Familie; weitere Schnitte bleiben als `@font-face` im Rest-CSS. |
| Leere Vorlagen-Seite | `page_empty` | `detail_exhibitions.html` hat im Export keinen Body — die dynamische Seite entsteht trotzdem, bleibt aber leer. |
| Spaltenbreite unter 480 px (`w-col-tiny-*`) | `widget_partial` | ycode hat für diese Stufe keinen Breakpoint (siehe erste Zeile), die Desktop- und Tablet-Breiten kommen mit. |
| Slider-Einstellung ohne Gegenstück (`data-nav-spacing`, `data-autoplay-limit`) | `widget_partial` | ycodes Slider-Modell kennt sie nicht; alles andere aus Webflows `data-*` wird übernommen. |
| Video in einer Lightbox-Galerie | `widget_partial` | ycodes Lightbox zeigt Bilder. |
| Tab-Link ohne passendes Panel | `widget_partial` | Ohne `data-w-tab`-Partner gibt es nichts zum Umschalten. |

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

## 5. Grenze des Exports

Ein Webflow-Code-Export enthält **keine CMS-Inhalte**: jede Collection-Liste besteht nur aus einem
leeren Vorlagen-Element, und die Bilder der Einträge stehen ausschließlich als CDN-Adressen in den
CSV-Dateien. Deshalb sieht die importierte Seite an diesen Stellen *voller* aus als der Export selbst
— der Export zeigt „No items found", der Import die echten Einträge.

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
