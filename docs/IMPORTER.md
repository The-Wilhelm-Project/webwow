# Webflow-Import

## Was heute funktioniert (Importer v1)

Im Builder unter **Einstellungen → Templates → „Import from Webflow"**: Webflow-Export-ZIP hochladen,
optional die CMS-CSV-Dateien dazu. Der Import legt Seiten, Collections, Einträge und Assets an und
hängt das Original-CSS als `custom_code_head` an, damit die Seiten aussehen wie im Export.

Mit dem Beispiel-Export (`import/`) verifiziert: 7 Seiten, 2 Collections, 121 Einträge, 70 Assets,
keine Fehler, keine kaputten Bilder.

**Grenzen von v1:** Die Layer tragen die Webflow-Klassennamen und das Original-CSS, nicht Tailwind.
Im Design-Panel des Builders lassen sich diese Werte deshalb nicht bearbeiten. Animationen und
Komponenten werden nicht übernommen, CMS-Bindungen nur heuristisch.

## Importer v2 (in Arbeit, noch nicht aktiv)

Unter `lib/webwow/import/webflow-zip/` liegt eine neue Pipeline, die den Export in das native
Modell von ycode überführt, damit alles im Builder bearbeitbar ist. Fertig und mit Tests abgedeckt:

| Modul | Aufgabe |
| --- | --- |
| `zip.ts` | Export-Archiv entpacken und klassifizieren, mit Größen- und Zip-Bomb-Grenzen |
| `safe-fetch.ts` | Nachladen von CDN-Bildern: nur HTTPS, Host-Allowlist, keine privaten Adressen, Größen-Budget |
| `css-tokenizer.ts`, `css.ts` | Webflow-CSS in Tailwind-Klassen und wiederverwendbare Layer-Styles übersetzen (Breakpoints, Hover, Combo-Klassen); Unübersetzbares als Rest-CSS |
| `css-sanitize.ts` | Rest-CSS entschärfen (kein Ausbruch aus `<style>`, kein `@import`, kein `javascript:`) |
| `html.ts` | HTML in die Zwischendarstellung des Upstream-Importers überführen |
| `cms.ts` | CSV-Dateien in Collections, Felder, Einträge und Referenzen |
| `binding.ts` | Collection-Listen und Detailseiten strukturell an Collections binden |
| `ix2-parse.ts`, `ix2.ts` | Webflow-Interaktionen lesen (ohne `eval`) und auf ycode-Animationen abbilden |
| `widgets.ts` | Menü- und Dropdown-Verhalten als Interaktion erzeugen |
| `fonts.ts` | Schriften übernehmen |

**Es fehlen noch** die Verdrahtungsmodule (`server-materializer.ts`, `convert-bridge.ts`,
`components.ts`, `pages.ts`, `index.ts`) und die API-Route. Solange die fehlen, ist der Code
unerreichbar und ändert am laufenden Betrieb nichts; es gilt weiter v1.

### Wichtige Randbedingung

Ein Webflow-Code-Export enthält **keine CMS-Inhalte**: jede Collection-Liste besteht nur aus einem
leeren Vorlagen-Element, und die Bilder der Einträge stehen ausschließlich als CDN-Adressen in den
CSV-Dateien. Der Importer lädt sie daher von Webflows CDN nach. Schlägt ein Download fehl, bleibt
die Original-Adresse im Feld stehen, damit das Bild auf der veröffentlichten Seite trotzdem erscheint.
