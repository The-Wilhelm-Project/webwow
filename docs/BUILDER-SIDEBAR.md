# Builder-Sidebar (Rail)

Die linke Seite des Builders (`/ycode/**`) ist nach dem Webflow-Designer aufgebaut: eine schmale
**Icon-Leiste (Rail)** ganz links, daneben höchstens ein **gepinntes Panel** (schiebt den Canvas nach
rechts) und höchstens ein **Flyout** (liegt über dem Canvas). Alles, was der ycode-Builder kann, bleibt
erhalten — die Panels wrappen die unveränderten Upstream-Komponenten (`LayersTree`, `LeftSidebarPages`,
`ElementLibrary`, `ComponentVariantsSection`, …).

Code: `app/(builder)/ycode/components/webwow/` (React) und `lib/webwow/builder/` (reine Logik mit
node:test-Tests). Mount in `app/(builder)/ycode/components/YCodeBuilderMain.tsx`.

## Rail-Items

Die Rail ist ein `<nav aria-label="Builder">` mit 48 px Breite und wird auf **jeder** `/ycode`-Route
gerendert — auch neben dem CMS, den Formularen, der Lokalisierung, den Integrationen und den
Einstellungen. Jedes Icon hat einen Tooltip „Name · Taste", `aria-pressed` (offen/geschlossen) und
`aria-current="page"`, wenn seine Route aktiv ist.

| Position | Item | Art | Inhalt | Rollen |
|---|---|---|---|---|
| oben | **Add** | Flyout | Upstream-`ElementLibrary` (Elements / Layouts / Components) inline | owner, admin, designer |
| oben | **Pages** | pinnbar | Seitenbaum mit Ordnern, Seiteneinstellungen, Kontextmenü (`LeftSidebarPages`) | alle (Editor read-only) |
| oben | **Navigator** | pinnbar | Layer-Baum der Seite bzw. Komponenten-Variante: Drag&Drop, Kontextmenü, Lock-Anzeige, Varianten (`LayersTree`, `ComponentVariantsSection`) | alle (Editor read-only) |
| oben | **Components** | Flyout | Alle Komponenten mit Suche. Klick oder Drag auf den Canvas fügt eine Instanz ein (wie der Components-Tab der ElementLibrary), der Stift öffnet `/ycode/components/<id>` | owner, admin, designer |
| oben | **Assets** | Flyout | Ordner, Thumbnail-Grid, Upload, „Neuer Ordner", Dateimanager. Klick setzt das Bild auf das gewählte Image-Layer | alle |
| oben | **CMS** | Flyout | Collections-Liste (Klick → `/ycode/collections/<id>`), Globale Variablen, „New collection" | alle (Editor ohne Anlegen) |
| oben | **Forms** | Flyout | Formulare mit Einsendungen → `/ycode/forms` | owner, admin, designer |
| oben | **Localization** | Flyout | Bearbeitungs-Locale wechseln, „Manage locales" → `/ycode/localization` | owner, admin, designer |
| oben | **Apps** | Flyout | Apps, Webhooks, MCP, API (`/ycode/integrations/*`) | owner, admin, designer |
| oben | **Settings** | Flyout | Abschnitte aus `lib/settings-nav-items.ts`, Dateimanager, Backup & Restore, Profil, Sites-Dashboard | owner, admin, designer |
| unten | **Find** | Aktion | Command-Palette (siehe unten) | owner, admin, designer |
| unten | **Help** | Flyout | Shortcut-Liste, Doku-Links, Shortcut-Dialog | alle |
| unten | **Theme** | Menü | System / Light / Dark — derselbe `localStorage`-Schlüssel `theme` und dieselbe `html.dark`-Klasse wie das Theme-Untermenü der HeaderBar; beide Menüs bleiben synchron (Event `webwow:theme`, siehe `lib/webwow/builder/theme.ts`) | alle |
| unten | **Profil** | Menü | Avatar-Dropdown: Mein Profil, Tastenkürzel, Abmelden | alle |

Kein Logo-/Hauptmenü-Item: das Wilhelm-Logo-Dropdown der HeaderBar (Settings, File manager, Integrations,
Backup & Restore, Theme, Tastenkürzel, Profil, Abmelden) bleibt das Hauptmenü; die Rail dupliziert es nicht.

Items, die eine Design-Route brauchen (Add, Navigator), sind auf CMS-/Settings-Routen ausgegraut
(Tooltip „open a page"). Die Sichtbarkeit pro Rolle und die Shortcut-Zuordnung stehen in
`lib/webwow/builder/rail-items.ts` (`RAIL_ITEMS`, `visibleRailItems`, `resolveRailShortcut`).

Navigation zu anderen Routen (Forms, Localization, Apps, Settings, Profil) merkt sich vorher die
Design-URL (`setLastDesignUrl`), damit der Header-Button „Design" wieder zurückführt — wie in der HeaderBar.

### Tastatur in der Rail

Die Rail ist **ein** Tab-Stopp (Roving-Tabindex): `↑`/`↓` bewegen den Fokus zwischen den Icons,
`Home`/`End` springen zum ersten/letzten Item, der Profil-Button ist Teil dieser Reihe. `↓` auf dem
Profil-Button öffnet dessen Menü (Radix-Standard für Menü-Buttons).

## Shortcuts

| Taste | Wirkung |
|---|---|
| `A` | Add öffnen/schließen |
| `P` | Pages öffnen/schließen (gepinnt: ein-/ausklappen) |
| `Z` | Navigator öffnen/schließen (gepinnt: ein-/ausklappen) |
| `Shift+A` | Components öffnen/schließen |
| `J` | Assets öffnen/schließen |
| `Esc` | offenes Flyout schließen, Fokus zurück auf das Rail-Icon (ohne Flyout: Upstream-Verhalten „Parent auswählen") |
| `Cmd/Ctrl+K` | Find-Palette öffnen/schließen (auch in Eingabefeldern) |

Buchstaben-Shortcuts feuern **nur**, wenn nichts Tippbares fokussiert ist und kein Popup offen ist:
Inputs, Textareas, contentEditable, Code-Editoren, Radix-Select-Listen (`role="option"` /
`role="listbox"`), Popover-Inhalte, Menüs und Dialoge blockieren sie (`isTypingTarget`,
`OPEN_POPUP_SELECTOR` in `rail-items.ts`). Mit gedrücktem `Cmd`/`Ctrl`/`Alt` oder bei Auto-Repeat feuern sie
nie. Der Handler läuft in der Capture-Phase, damit die Upstream-Handler für `A` und `Esc` keinen Treffer
doppelt ausführen; das Upstream-Event `toggleElementLibrary` (Canvas-Button „Add layout", Upstream-`A`)
wird weiterhin bedient — ohne `detail.tab` mit derselben Sperre.

Die Help-Panel-Liste und der Shortcut-Dialog (`Shift+/`) zeigen zusätzlich die Upstream-Shortcuts
(Kopieren/Einfügen, Undo/Redo, Zoom, Komponente erstellen, …), die unverändert gelten. Auf Windows/Linux
zeigt das Help-Panel `Ctrl` nur für Kombinationen, deren Upstream-Handler `Ctrl` akzeptiert (Copy, Paste,
Undo, Zoom, Save, …); die reinen Meta-Kombinationen (Copy/Paste style, Create component, Detach instance,
Show/hide element — Upstream prüft dort nur `e.metaKey`) erscheinen als `Win` bzw. `Meta`
(`detectPlatform` / `metaKeyLabel` in `rail-items.ts`).

Im **Preview-Modus** (Overlay über Rail und Canvas) sind die Rail-Shortcuts, das Event
`toggleElementLibrary` und die Find-Palette abgeschaltet; ein offenes Flyout und die Palette schließen beim
Start der Vorschau (`isPreviewMode` aus `useEditorStore`).

## Pinnen, Flyouts und Breite

* **Navigator** und **Pages** sind pinnbar (Pin-Icon im Panel-Header). Gepinnt bleibt das Panel offen,
  schiebt den Canvas nach rechts und hat rechts einen Resize-Griff (240–480 px, Doppelklick = 300 px).
  Es kann immer nur ein Panel gepinnt sein; das andere öffnet dann als Flyout. Das X am gepinnten Panel
  klappt es ein (Session), das Icon oder die Taste klappt es wieder aus.
* Alle anderen Panels sind **Flyouts** (300 px, `position: fixed` neben Rail + gepinntem Panel). Sie
  schließen bei Klick in den Canvas (Upstream-Event `closeElementLibrary`), bei `mousedown` außerhalb von
  Rail und Panel, wenn der Fokus in das Canvas-iframe wandert, bei `Esc` und beim erneuten Klick auf das
  aktive Icon. Dialoge, Popover, Tooltips und Toasts zählen nicht als „außerhalb".
* Default: Navigator gepinnt (Bestandsverhalten des Builders). Ein `/ycode/pages/<id>`-Link öffnet Pages
  zusätzlich als Flyout, wenn es nicht gepinnt ist.
* Beim Öffnen wandert der Fokus in das Panel (Suchfeld, sonst Titel; im Pages-Panel auf den Listen-Container,
  weil die Upstream-Seitenliste weder Suchfeld noch fokussierbaren Titel hat – `Tab` erreicht dann direkt das
  `+`-Menü und die Seitenzeilen statt erst den gepinnten Navigator); `Esc` gibt ihn an das Rail-Icon zurück.
  `Esc` im Suchfeld eines Panels leert erst die Suche und schließt beim zweiten Mal – auch dann geht der Fokus
  zurück auf das Rail-Icon (`RailPanel`-Prop `onEscape`, der globale Esc-Handler sieht Tastendrücke in
  Eingabefeldern nicht).
* Der Resize-Griff des gepinnten Panels ragt 6 px über den Panelrand in den Canvas (12 px Trefferzone, Linie
  bei Hover). Deshalb hat die Panel-`<section>` kein `overflow: hidden`; der Inhalt wird vom Body-Wrapper
  darunter beschnitten.
* Die Pages-Seiteneinstellungen können ungespeicherte Änderungen haben: vor dem Ausblenden des Pages-Panels
  fragt `checkAndCloseSettings()` wie bisher nach.

### Persistenz: `localStorage["webwow.rail.v1"]`

```json
{ "pinned": "navigator" | "pages" | null, "width": 300 }
```

`collapsed` und das offene Flyout werden nicht gespeichert. Jeder Zugriff auf den Speicher läuft über
`readRailStorage()` / `writeRailStorage()` (`safeGet` / `safeSet`, try/catch um jeden Aufruf): in privaten
Fenstern, bei blockiertem Storage oder vollem Kontingent läuft der Builder mit den Defaults weiter.
Die Breite des gepinnten Panels wird von `useRailResize` (eigener Hook in `useRailState.ts`) verwaltet und
ebenfalls nur über `writeRailStorage()` gespeichert — der Upstream-Hook `useResizableSidebar` (unabgesicherte
`localStorage`-Zugriffe) wird für die Rail nicht benutzt. Ungültige oder alte Werte fallen auf die Defaults
zurück (`parseRailStorage`).

`leftSidebarWidth` im `useEditorStore` (die Upstream-Komponenten lesen ihn für Overlays) ist die rechte
Kante des linken Stapels: Rail + gepinntes Panel + Flyout. Der Layer-Baum (`LayersTree`) leitet seine
Zeilenbreite dagegen aus der sichtbaren Panelbreite ab: `NavigatorPanel` übergibt `availableWidth`
(gepinnte Breite bzw. 300 px als Flyout), sonst wären die Zeilen so breit wie der ganze Stapel und der
Baum liefe horizontal weit über das Panel hinaus.

## Find-Palette (`Cmd/Ctrl+K`)

Eigene Palette auf `Dialog` + `Input` + Listbox (keine neue Dependency). Durchsucht Seiten, Layer der
aktuellen Seite bzw. Komponenten-Variante, Collections, Komponenten und Aktionen (Publish, Preview,
Panels öffnen/pinnen, Dateimanager, Settings-Abschnitte, Forms, Localization, Apps, Webhooks, MCP, Profil,
Tastenkürzel, Sign out). Ohne Suchbegriff: aktuelle Seite zuerst, dann einige Seiten und alle Aktionen.
`↑`/`↓` navigieren, `↵` öffnet, `Esc` schließt. Die Aktion „Publish" feuert das Window-Event
`webwow:publish`; die HeaderBar öffnet darauf ihr Publish-Popover (kein zweiter Publish-Pfad). Die Palette
abonniert die Stores nur, solange sie offen ist.

## URL-Sync und Store

Ist Pages sichtbar (Flyout oder gepinnt), zeigt die URL `/ycode/pages/<id>`, sonst `/ycode/layers/<id>`
(`history.replaceState`). Der Store-Tab `activeSidebarTab` im `useEditorStore` ist davon **entkoppelt**:
er ist auf Design-Routen nur `pages`, solange das Pages-**Flyout** den Canvas überlagert (der Zustand
„Pages-Tab" der Upstream-Sidebar: Layer-Shortcuts in `YCodeBuilderMain` und die Auswahl-Overlays des Canvas
sind aus), sonst `layers`. Ein gepinntes Pages-Panel ist kein Modus – daneben sind Canvas, Navigator-Flyout
(`Z`) und Find voll benutzbar, Shortcuts (Tab, Pfeile, Delete, Copy/Paste, …) und Auswahl-Rahmen bleiben an.
Setzt jemand anderes den Store-Tab (HeaderBar-Buttons „Pages"/„Content editor" der Editor-Rolle, Canvas,
Preview-Toggle), wendet die Rail ihn zuerst auf die Panels an: `pages` öffnet das Pages-Flyout bzw. klappt ein
eingeklapptes gepinntes Panel auf, `layers` schließt ein Pages-Flyout (ein gepinntes Pages-Panel bleibt); der
folgende Render leitet den Tab dann wieder aus dem Rail-Zustand ab, ein externer Wert bleibt also nie „hängen"
(bei gepinntem Pages wird ein externes `pages` sofort wieder zu `layers`). Die Rail merkt sich jeden Tab, den
sie selbst schreibt, und vergleicht einen Store-Tab mit dem **aktuellen** Store-Wert (`getState()`), nicht mit
dem Render-Wert: beim Mount schreibt sie zuerst den URL-Tab (`pages` bei `/ycode/pages/<id>`), während derselbe
Render noch den Store-Default `layers` hält – sonst würde das initiale Pages-Flyout als „externes `layers`"
sofort wieder geschlossen und die URL auf `/layers/` umgeschrieben. Wählt die Find-Palette einen Layer, öffnet
die Rail das Navigator-Flyout bzw. schließt ein offenes Pages-Flyout neben einem gepinnten Navigator.

Der Komponenten-Editor wird aus dem Components-Panel (Stift) und der Palette über den Upstream-Hook
`useEditComponent` geöffnet — derselbe Pfad wie „Edit component" in der rechten Sidebar, der Canvas-Doppelklick
und „Edit" im Komponenten-Menü der ElementLibrary. Damit die Navigation nicht verloren geht, hält
`YCodeBuilderMain` die `?layer=`-Spiegelung an, solange Store (`editingComponentId`) und Route nicht
übereinstimmen (ein `history.replaceState` während des laufenden App-Router-Push würde die alte Route
wiederherstellen), und ergänzt `?layer=` nach dem Routenwechsel.
Die Header-Buttons Design | CMS | Forms funktionieren weiter; auf `/ycode/collections` bleibt die
Collections-Sidebar von `CMS.tsx` unverändert neben der Rail.

## Editor-Rolle (`?edit`)

Editor-Sessions (Rolle `editor`, siehe [EDITOR.md](EDITOR.md)) sehen nur Pages (read-only), Navigator
(read-only), Assets, CMS (ohne „New collection"), Help, Theme und Profil. Add, Components, Forms, Localization, Apps,
Settings und Find fehlen; die Struktur-Shortcuts (`A`, `Shift+A`, `Cmd/Ctrl+K`) feuern nicht. Der Server
erzwingt die Rechte unabhängig davon (`lib/webwow/proxy-policy.ts`).

## Performance

`WebwowLeftSidebar`, `Rail`, `ProfileMenu` und alle Panels sind mit `React.memo` umhüllt und bekommen
ausschließlich primitive bzw. stabile Props (Callbacks per `useCallback`, Close-Handler pro Panel per
`useMemo`); `YCodeBuilderMain` reicht `onLayerSelect` / `onPageSelect` als `useCallback` durch. Ein Hover
im Layer-Baum oder ein Re-Render des Builders rendert weder Rail noch versteckte Panels neu. Versteckte
Panels bleiben gemountet (Zustand, sofortiges Öffnen); das Assets-Panel pausiert seine Auswahl-Subscription,
solange es versteckt ist, und rendert Kacheln memoisiert.

## Fallback: klassische Sidebar

```
NEXT_PUBLIC_WEBWOW_CLASSIC_SIDEBAR=1
```

in `.env` (siehe `.env.example`) mountet wieder die Upstream-`LeftSidebar` (Tabs Layers | Pages, Plus-Button
für die ElementLibrary) und lässt die Rail weg. Die Variable wird beim Build/Start eingebettet
(`NEXT_PUBLIC_*`); nach dem Ändern Dev-Server bzw. Build neu starten. `LeftSidebar.tsx` bleibt
Upstream-identisch.

## Divergenz-Einträge (Upstream-Sync)

* `app/(builder)/ycode/components/webwow/**` und `lib/webwow/builder/**` — eigene Dateien, in
  `scripts/sync-lists.sh` (`DIVERGENT_PREFIXES`) und [UPSTREAM-SYNC.md](UPSTREAM-SYNC.md) §2b.
* `app/(builder)/ycode/components/YCodeBuilderMain.tsx` (Sidebar-Mount, `useClassicSidebar`, memoisierte
  Callbacks), `app/(builder)/ycode/components/HeaderBar.tsx` (Publish- und Theme-Event) und
  `app/(builder)/ycode/components/LayersTree.tsx` (optionaler Prop `availableWidth`, sonst Upstream-Verhalten)
  — §2a mit Re-Apply-Hinweisen.
* Nicht geändert: `LeftSidebar.tsx`, `LeftSidebarPages.tsx`, `ElementLibrary.tsx`, `components/ui/icon.tsx`
  (fehlende Icons liegen in `webwow/rail-icons.tsx`).

## Verifikation

* `npx eslint app/\(builder\)/ycode/components/webwow lib/webwow/builder --fix`, `npx tsc --noEmit`,
  `npm test` (Tests in `lib/webwow/builder/*.test.ts`), `bash scripts/check-upstream-identity.sh`.
* Browser: Playwright gegen den Dev-Server (`http://localhost:3003`), u. a. Panels, Pinnen, Shortcuts mit
  offenem Select/Popover, Roving-Tabindex, blockierter `localStorage`, Render-Zähler beim Hover im Layer-Baum.
