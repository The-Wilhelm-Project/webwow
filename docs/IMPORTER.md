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

## 5. Grenze des Exports

Ein Webflow-Code-Export enthält **keine CMS-Inhalte**: jede Collection-Liste besteht nur aus einem
leeren Vorlagen-Element, und die Bilder der Einträge stehen ausschließlich als CDN-Adressen in den
CSV-Dateien. Deshalb sieht die importierte Seite an diesen Stellen *voller* aus als der Export selbst
— der Export zeigt „No items found", der Import die echten Einträge.

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
