# Universal Website Ontology

A base schema for "everything a website can be about": a company, a school, a clinic, an artist, a craft business, an agency. It ships as a template that creates all CMS collections, a coherent set of sample data, one folder with a list page and a detail page per collection, and a few static wireframe pages (Home, About, Contact, FAQ, Legal). Every detail page has SEO bindings and shows up in the sitemap automatically.

The definition lives in `lib/webwow/templates/universal-ontology.ts`, the generator in `lib/webwow/templates/universal-template.ts` (Webwow-owned paths, see [UPSTREAM-SYNC.md](UPSTREAM-SYNC.md) §2b).

## How to apply it

| Entry point | How |
| --- | --- |
| Builder | Left rail → **CMS** panel → **Universal ontology** (roles that may edit the structure) |
| CLI | `npm run webwow:universal-template` (`--no-samples`, `--no-pages`, `--site <slug>` for another site) |
| API | `POST /ycode/api/webwow/templates/universal` with `{ "withSamples": true, "withPages": true }` (`GET` returns the definition; builder session required, denied for `?edit` editor sessions) |
| MCP | `apply_universal_template` (and `get_universal_ontology` to read the schema); applies to the site of the MCP token |

The template is additive and safe to re-run: collections (matched by name), folders (by slug) and pages are reused, never overwritten. Everything is created as draft; publish when you are happy with it. An empty default homepage is filled with the Home wireframe.

## Design rules

1. **One collection per real-world thing, never two for the same thing in different states.** A past exhibition and an upcoming workshop are both *Events*; the history timeline is "events in the past", the announcements are "events in the future". Milestones (founding, certification) are events of type `milestone`.
2. **Variants are a `type` text field**, not a separate collection. The allowed values are documented per collection (and in the field hint) but not enforced, so niche projects can add their own.
3. **Relations mirror the real graph**: a person works for an organization, an organization sits at a place, an event happens at a place, an article has an author. Each relation is a reference field; the reverse direction is rendered automatically on the detail page (inverse lists).
4. **Schema.org as orientation, not as law.** Schema.org is often too fine-grained (dozens of event and organization subtypes). We keep its top-level entities and fold the subtypes into `type`. For organizations and people we also borrow what LinkedIn, Google Business and the German legal requirements (TMG/DDG § 5, DL-InfoV, MStV § 18) expect.
5. **Legal texts belong to the organization.** Imprint, privacy policy, terms, register, chamber and representatives are fields on *Organizations*. The Legal page is generated from the organization with `relationship = own`.
6. **Every collection is a SEO page.** Each collection gets `/<folder>` (list) and `/<folder>/{slug}` (detail). Detail pages bind the SEO title to `name`, the description to `summary` and the OG image to the cover field. Dynamic pages are expanded in the sitemap.

## Collections

| Collection | Schema.org | Replaces (typical names) | URL |
| --- | --- | --- | --- |
| **Organizations** | Organization | Corporates, Unternehmen, Clients, Partners, Schools, Departments | `/organizations` |
| **People** | Person | Team, Employees, Ansprechpartner, Artists, Authors, Doctors | `/people` |
| **Places** | Place | Standorte, Locations, Venues, Plants, Practices | `/places` |
| **Brands** | Brand | Corporate Design, CI/CD, Marke, design tokens | `/brands` |
| **Channels** | ContactPoint | Social profiles, hotlines, newsletter | – (no pages) |
| **Events** | Event | Exhibitions, Histories, Milestones, Sessions, Courses, Termine | `/events` |
| **Articles** | Article | Blog, News, Seiten, Case studies, Press, FAQ, Testimonials, Guides | `/articles` |
| **Works** | CreativeWork | Werke, Portfolio, Projects, Documents, Downloads, Equipment, Pins | `/works` |
| **Offerings** | Offer | Leistungen, Services, Products, Maßnahmen, Courses, Packages | `/offerings` |
| **Jobs** | JobPosting | Stellen, Careers, Vacancies | `/jobs` |
| **Attributes** | DefinedTerm | Labels, Werte, Ziele, USPs, Benefits, Zertifizierungen, Skills, Awards | `/attributes` |
| **Categories** | DefinedTermSet | Tags, Topics, Industries, Series | `/categories` |

Every collection has the built-in fields `id`, `status`, `name`, `slug`, `created_at`, `updated_at`.

### Organizations

| Field | Type | Notes |
| --- | --- | --- |
| type | text | company, department, school, clinic, practice, studio, agency, workshop, nonprofit, association, institution, venue, gallery, club |
| relationship | text | own, client, partner, supplier, member, sponsor, gallery |
| tagline, summary, description | text, text, rich text | |
| logo, cover | image | |
| founded | date | |
| size | text | "1-10", "11-50", … (LinkedIn style) |
| email, phone, website | email, phone, link | |
| legal_name, legal_form, representatives | text | Vertretungsberechtigte |
| register_court, register_number, vat_id, tax_number | text | HRB etc. |
| supervisory_authority, chamber, profession_title, professional_regulations | text, text, text, link | regulated professions (clinics, crafts, lawyers) |
| responsible_content | text | § 18 MStV |
| imprint, privacy_policy, terms | rich text | rendered on the Legal page |
| headquarters | → Places | |
| parent | → Organizations | subsidiaries, departments |
| brand | → Brands | |
| attributes | ⇉ Attributes | values, certifications, USPs |
| categories | ⇉ Categories | industry |
| featured | boolean | |

Inverse lists on the detail page: Team (People), Places, Offerings, Events, Jobs, Works, Articles, Channels.

### People

type (employee, founder, management, artist, doctor, teacher, contact, author, student, partner, alumni), title, first_name, last_name, role, summary, bio, photo, email, phone, website, languages, office_hours, organization → Organizations, place → Places, attributes ⇉ Attributes (skills, qualifications), categories, featured.

Inverse: Articles (author), Works (creator), Events (participants), Offerings (contact), Jobs (contact), Channels.

### Places

type (headquarters, office, branch, plant, warehouse, store, practice, ward, venue, school, studio, region, city), street, postal_code, city, region, country, latitude, longitude, map, image, summary, description, opening_hours, email, phone, organization → Organizations, contact → People, offerings ⇉ Offerings.

Inverse: Events, People, Jobs.

### Brands

type (corporate, product, campaign, sub_brand), claim, summary, description, color_primary / secondary / accent / background / text, logo, logo_wordmark, logo_light, logo_dark, favicon, font_heading, font_body, brand_guide (document), organization → Organizations.

Inverse: Organizations (brand), Offerings (brand).

### Channels

platform (website, phone, hotline, email, instagram, linkedin, facebook, youtube, tiktok, pinterest, x, github, mastodon, whatsapp, newsletter), url, handle, icon, person → People, organization → Organizations.

### Events

type (exhibition, milestone, course, workshop, session, fair, talk, meeting, announcement, release, opening), start, end, fact, summary, description, image, gallery, place → Places, organizer → Organizations, participants ⇉ People, works ⇉ Works, offering → Offerings, categories, price, capacity, link, featured.

Inverse: Articles (event).

### Articles

type (post, news, page, case_study, press, faq, testimonial, guide, landing), subtitle, summary, body, cover, gallery, published_at, author → People, organization → Organizations, event → Events, works ⇉ Works, offerings ⇉ Offerings, categories, related ⇉ Articles, rating, source, featured.

### Works

type (artwork, project, reference, equipment, document, download, photo, video, audio, pin), summary, description, image, gallery, file (document), media (link), year, date, medium, dimensions, price, availability, creator → People, organization → Organizations, categories, featured.

Inverse: Events (works), Articles (works), Offerings (works).

### Offerings

type (service, product, course, package, measure, membership, rental), summary, description, icon, image, price, price_unit, effort, duration, organization → Organizations, brand → Brands, contact → People, attributes ⇉ Attributes, works ⇉ Works, categories, link, featured.

Inverse: Events (offering), Places (offerings), Articles (offerings).

### Jobs

type (full_time, part_time, mini_job, apprenticeship, internship, freelance, volunteer, unsolicited), subtitle, summary, tasks, requirements, cover, benefits ⇉ Attributes, organization → Organizations, place → Places, contact → People, posted_at, valid_through, apply_link, apply_email, categories, featured.

### Attributes

type (value, usp, benefit, goal, certification, skill, label, award), summary, description, icon, image, fact, date, valid_through, issuer → Organizations, document, link, leads_to ⇉ Attributes (goal graph), highlight.

Inverse: Organizations, People, Offerings, Jobs (benefits), Attributes (supported by).

### Categories

kind (category, tag, topic, industry, series, department, medium), summary, icon, color, parent → Categories.

Inverse: Subcategories, Articles, Works, Events, Offerings, Organizations, People, Jobs.

## Generated pages

| Page | Content |
| --- | --- |
| `/` | Hero, featured offerings, upcoming & recent events, latest posts, values (attributes of type `value`), clients & partners |
| `/about` | Own organization, team, history (events of type `milestone`), certifications, testimonials |
| `/contact` | Places, contact persons, contact form |
| `/faq` | Articles of type `faq` |
| `/legal` | Imprint, privacy policy and terms from the organization with `relationship = own` |
| `/<collection>` | List page with linked cards (cover, name, subtitle, summary) |
| `/<collection>/{slug}` | Detail page: type, name, subtitle, summary, cover, rich text blocks, details list, one linked list per reference field, one list per inverse relation |

All generated layers are plain Tailwind wireframes and can be restyled, rearranged or deleted in the builder like any other layer. Empty detail rows and empty relation sections are hidden through conditional visibility.

## Use cases

**Artist.** Works (type `artwork`, with medium, dimensions, price, availability, series via Categories), Events (`exhibition`, `fair`, `opening`, with place and the shown works), CV as Events of type `milestone` plus Attributes of type `award`, press as Articles of type `press`, galleries as Organizations with `relationship = gallery`, studio as Place.

**Craft business.** Offerings (`service`), references as Works (`reference`/`project`), Team (People), Attributes of type `certification` (Meisterbetrieb, Innung) and `usp` (24h emergency service), Jobs, Places (workshop, service region as Place of type `region`), reviews as Articles (`testimonial`), chamber and supervisory authority on the Organization.

**Manufacturer with 15 sites.** One Organization per legal entity with `parent`, 15 Places (`plant`, `warehouse`, `office`) each with its own contact person and the offerings available there, products as Offerings (`product`) with product brands, machinery as Works (`equipment`), downloads as Works (`document`), ISO certificates as Attributes (`certification`) with issuer and validity, history as Events (`milestone`), jobs per place, industries as Categories (`industry`).

**Agency.** Offerings (`service`, `package`), clients as Organizations (`relationship = client`) with their Brands, case studies as Articles (`case_study`) linked to the client, the offerings and the project (Works), team, jobs, blog, awards as Attributes, testimonials.

**Clinic.** Departments as Organizations of type `department` with `parent`, doctors as People (`doctor`) with qualifications (Attributes `certification`/`skill`), office hours and languages, treatments as Offerings (`service`), wards and buildings as Places (`ward`, `practice`), emergency numbers as Channels (`hotline`), info evenings and courses as Events, patient information as Articles (`guide`), forms as Works (`document`), Ärztekammer, supervisory authority and professional title on the Organization.

## Extending

Add fields or collections in the builder as usual. To extend the template itself, edit `lib/webwow/templates/universal-ontology.ts`: a new field only needs `key`, `name`, `type` and a `role` that tells the generator where it belongs on the wireframe (`subtitle`, `summary`, `body`, `cover`, `gallery`, `meta`, `relation`, `hidden`). Reference fields point to another collection by `ref`; `inverse` entries render the reverse direction.
