# Inhalts-Editor (`?edit`)

Ein vereinfachter Editor nur für Inhalte – wie der Editor von Webflow. Wer das Editor-Passwort
einer Website kennt, kann Texte, Bilder und CMS-Einträge pflegen, aber nichts am Design ändern.

## Einrichten

1. Als Owner oder Admin die Übersichtsseite `/webwow` öffnen.
2. Auf der Karte der Website das Menü (…) öffnen → **Settings**.
3. Unter **Editor access** ein Passwort setzen (mindestens 10 Zeichen) und speichern.

Alternativ über die Kommandozeile:

```bash
npm run webwow:sites -- set-editor-password <slug> <passwort>
npm run webwow:sites -- set-editor-password <slug> -        # Zugang wieder abschalten
```

## Benutzen

An jede öffentliche Seite `?edit` anhängen:

```
https://www.beispiel.de/?edit
https://www.beispiel.de/ueber-uns?edit
```

Webwow leitet auf die Passwortseite weiter und danach in den Inhalts-Editor (`/ycode/collections`).
Nach dem Abmelden landet man wieder auf der Seite, von der man kam.

Wer bereits als normaler Benutzer angemeldet ist, braucht kein Passwort: der Klick auf `?edit`
öffnet den Editor direkt.

## Was Redakteure dürfen

| Erlaubt | Gesperrt |
| --- | --- |
| CMS-Collections und -Einträge anlegen, ändern, löschen | Design, Layout, Layer-Struktur |
| Texte, Bilder, Links und Medien auf Seiten ändern | Seiten anlegen, umbenennen, löschen |
| Assets hochladen, Übersetzungen pflegen | Einstellungen, Benutzer, Integrationen |
| Veröffentlichen | Sites-Verwaltung, API-Keys, MCP-Tokens, Projekt-Export |

Die Regeln stehen als Tabelle in `lib/webwow/proxy-policy.ts` und werden im Proxy durchgesetzt,
also serverseitig – nicht nur in der Oberfläche.

## Sitzungen und Sicherheit

- Eine Editor-Sitzung gilt **12 Stunden** und ist fest an eine Website gebunden.
- Ändert oder löscht man das Editor-Passwort, werden **alle offenen Editor-Sitzungen ungültig**
  (die Sitzung trägt die Passwort-Version im Token).
- Fehlversuche werden gebremst: 20 pro Website in 5 Minuten, danach eine wachsende Sperre.
  Eine zusätzliche Sperre pro IP greift nur mit `WEBWOW_TRUSTED_PROXY=1`, weil ein Client die
  Absender-IP sonst selbst behaupten kann.
- Für jede Website gibt es ein technisches Konto (`editor@<slug>.sites.webwow.local`, Rolle
  `editor`). Es taucht in der Benutzerliste auf, kann sich aber nicht über das normale
  Login-Formular anmelden und nicht zu einem echten Konto umgewidmet werden.
- Hinter einem HTTPS-Proxy, der `x-forwarded-proto` nicht setzt, `WEBWOW_SECURE_COOKIES=true` setzen.

## Grenzen

- Alle Redakteure einer Website teilen sich ein Passwort; es gibt keine getrennten Redakteurskonten
  (dafür echte Benutzer mit der Rolle `editor` unter Einstellungen → Benutzer anlegen).
- Die Sitzung wird nicht verlängert; nach 12 Stunden ist ein erneutes Anmelden nötig.
- `?edit` wirkt nur auf veröffentlichten Seiten. Innerhalb des Builders bleibt `?edit` unverändert
  für die interne Verwendung reserviert.
