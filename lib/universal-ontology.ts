import type { CollectionFieldType } from '@/types';

/**
 * Universal Website Ontology
 *
 * A small, graph-like base schema that can describe what a company, a school,
 * an artist, an agency or a club "has": organizations, people, places, brands,
 * channels, events, articles, works, offerings, jobs, attributes and categories.
 *
 * Design rules (deliberately simple, close to the real-world graph):
 * - One collection per real-world thing, never two collections for the same
 *   thing in different states. Variants are expressed via a `type` text field
 *   (e.g. an Event is an exhibition, a milestone, a course or an announcement;
 *   past events are the history, future events are upcoming).
 * - Relations are reference / multi-reference fields that mirror Schema.org
 *   (Organization, Person, Place, Brand, Event, Article, CreativeWork, Offer,
 *   JobPosting, DefinedTerm).
 * - Every collection gets the built-in fields `id`, `status`, `name`, `slug`,
 *   `created_at`, `updated_at` (added by the template service).
 *
 * The definition is declarative so it can also be read as documentation and
 * used by other tooling (MCP, CLI, UI).
 */

/** Wireframe role of a field: decides where the field is rendered on generated pages. */
export type OntologyFieldRole =
  | 'subtitle' // rendered right under the title
  | 'summary' // short text, rendered on cards and under the subtitle
  | 'body' // rich text content block
  | 'cover' // main image (hero / card image)
  | 'gallery' // multi image field
  | 'meta' // rendered in the "details" list (label: value)
  | 'relation' // reference / multi reference rendered as linked list
  | 'hidden'; // not rendered on generated pages (still available in the CMS)

export interface OntologyField {
  /** Field key (also used as the value key in sample items) */
  key: string;
  /** Display name */
  name: string;
  type: CollectionFieldType;
  /** For reference / multi_reference: key of the target ontology collection */
  ref?: string;
  /** For image fields: allow multiple assets */
  multiple?: boolean;
  /** Default value */
  default?: string;
  /** Where the field appears on generated wireframe pages */
  role?: OntologyFieldRole;
  /** Documentation hint (also used for the `type` vocabulary) */
  hint?: string;
}

export interface OntologyInverseRelation {
  /** Key of the collection holding the reference field */
  collection: string;
  /** Key of the reference field on that collection pointing back here */
  field: string;
  /** Section label on the detail page */
  label: string;
}

export type OntologySampleValue = string | string[] | number | boolean;

export interface OntologySampleItem {
  /** Values keyed by field key. Reference values are slugs of the target collection. */
  values: Record<string, OntologySampleValue>;
  /** Image filenames from `storage/collections` keyed by field key */
  images?: Record<string, string>;
}

export interface OntologyCollection {
  key: string;
  name: string;
  /** Schema.org type this collection maps to */
  schemaOrg: string;
  /** Typical names this collection replaces in real projects (German + English) */
  aliases: string[];
  description: string;
  /** URL folder for the generated list + detail pages (null = no pages) */
  folderSlug: string | null;
  /** Allowed values for the `type` field (documentation; not enforced) */
  types?: string[];
  fields: OntologyField[];
  /** Relations from other collections pointing here, rendered on the detail page */
  inverse?: OntologyInverseRelation[];
  samples: OntologySampleItem[];
}

export interface OntologyStaticSection {
  /** Section heading */
  title: string;
  /** Static paragraph under the heading */
  text?: string;
  /** Collection to list in this section */
  collection?: string;
  /** Optional filter on a text field (operator "is") */
  filter?: { field: string; value: string };
  /** Sort field key (`manual` when omitted) */
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  /** Render these fields of every item as full blocks instead of linked cards (e.g. legal texts) */
  fields?: string[];
  /** Render a contact form in this section */
  form?: boolean;
}

export interface OntologyStaticPage {
  name: string;
  slug: string;
  isIndex?: boolean;
  sections: OntologyStaticSection[];
}

export interface UniversalOntology {
  version: string;
  collections: OntologyCollection[];
  pages: OntologyStaticPage[];
}

/* -------------------------------------------------------------------------- */
/*                               Field helpers                                */
/* -------------------------------------------------------------------------- */

const typeField = (hint: string, def: string): OntologyField => ({
  key: 'type',
  name: 'Type',
  type: 'text',
  default: def,
  role: 'meta',
  hint,
});

const featuredField: OntologyField = {
  key: 'featured',
  name: 'Featured',
  type: 'boolean',
  default: 'false',
  role: 'hidden',
  hint: 'Highlight on the homepage / in lists',
};

const categoriesField: OntologyField = {
  key: 'categories',
  name: 'Categories',
  type: 'multi_reference',
  ref: 'categories',
  role: 'relation',
};

/* -------------------------------------------------------------------------- */
/*                                Collections                                 */
/* -------------------------------------------------------------------------- */

export const UNIVERSAL_ONTOLOGY: UniversalOntology = {
  version: '1.0.0',
  collections: [
    /* ------------------------------ Organizations ------------------------- */
    {
      key: 'organizations',
      name: 'Organizations',
      schemaOrg: 'Organization',
      aliases: ['Corporates', 'Unternehmen', 'Clients', 'Partners', 'Schools', 'Studios', 'Galleries'],
      description:
        'Every legal or informal body: your own company, a school, a clinic, a studio, a department, but also clients, partners and suppliers. The `relationship` field says how the organization relates to the site owner. Carries the legally required information (imprint, privacy policy, register, chamber) so legal pages are generated from the organization itself.',
      folderSlug: 'organizations',
      types: ['company', 'department', 'school', 'clinic', 'practice', 'studio', 'agency', 'workshop', 'nonprofit', 'association', 'institution', 'venue', 'gallery', 'club'],
      fields: [
        typeField('company | department | school | clinic | practice | studio | agency | workshop | nonprofit | association | institution | venue | gallery | club', 'company'),
        { key: 'relationship', name: 'Relationship', type: 'text', default: 'own', role: 'meta', hint: 'own | client | partner | supplier | member | sponsor | gallery' },
        { key: 'tagline', name: 'Tagline', type: 'text', role: 'subtitle' },
        { key: 'summary', name: 'Summary', type: 'text', role: 'summary' },
        { key: 'description', name: 'Description', type: 'rich_text', role: 'body' },
        { key: 'logo', name: 'Logo', type: 'image', role: 'cover' },
        { key: 'cover', name: 'Cover image', type: 'image', role: 'gallery' },
        { key: 'founded', name: 'Founded', type: 'date', role: 'meta' },
        { key: 'size', name: 'Size', type: 'text', role: 'meta', hint: 'Employees, e.g. "1-10", "11-50", "51-200"' },
        { key: 'email', name: 'Email', type: 'email', role: 'meta' },
        { key: 'phone', name: 'Phone', type: 'phone', role: 'meta' },
        { key: 'website', name: 'Website', type: 'link', role: 'meta' },
        // Legal information (German TMG/DDG § 5, DL-InfoV, MStV § 18, BGB) - shown on the Legal page
        { key: 'legal_name', name: 'Legal name', type: 'text', role: 'meta', hint: 'Name as registered, e.g. "Example Studio GmbH"' },
        { key: 'legal_form', name: 'Legal form', type: 'text', role: 'meta', hint: 'GmbH | UG | AG | e.K. | GbR | e.V. | freelancer | sole proprietor' },
        { key: 'representatives', name: 'Representatives', type: 'text', role: 'meta', hint: 'Managing directors / board (Vertretungsberechtigte)' },
        { key: 'register_court', name: 'Register court', type: 'text', role: 'meta', hint: 'e.g. "Amtsgericht Berlin-Charlottenburg"' },
        { key: 'register_number', name: 'Register number', type: 'text', role: 'meta', hint: 'e.g. "HRB 123456"' },
        { key: 'vat_id', name: 'VAT ID', type: 'text', role: 'meta' },
        { key: 'tax_number', name: 'Tax number', type: 'text', role: 'hidden' },
        { key: 'supervisory_authority', name: 'Supervisory authority', type: 'text', role: 'meta', hint: 'Aufsichtsbehörde (regulated professions, clinics, crafts)' },
        { key: 'chamber', name: 'Chamber', type: 'text', role: 'meta', hint: 'e.g. "Handwerkskammer Berlin", "Ärztekammer Bayern"' },
        { key: 'profession_title', name: 'Professional title', type: 'text', role: 'meta', hint: 'Berufsbezeichnung and the country it was awarded in' },
        { key: 'professional_regulations', name: 'Professional regulations', type: 'link', role: 'meta', hint: 'Link to the applicable regulations (berufsrechtliche Regelungen)' },
        { key: 'responsible_content', name: 'Responsible for content', type: 'text', role: 'meta', hint: '§ 18 Abs. 2 MStV' },
        { key: 'imprint', name: 'Imprint', type: 'rich_text', role: 'hidden', hint: 'Additional imprint text (liability, copyright, dispute resolution)' },
        { key: 'privacy_policy', name: 'Privacy policy', type: 'rich_text', role: 'hidden' },
        { key: 'terms', name: 'Terms & conditions', type: 'rich_text', role: 'hidden', hint: 'AGB' },
        { key: 'headquarters', name: 'Headquarters', type: 'reference', ref: 'places', role: 'relation' },
        { key: 'parent', name: 'Parent organization', type: 'reference', ref: 'organizations', role: 'relation' },
        { key: 'brand', name: 'Brand', type: 'reference', ref: 'brands', role: 'relation' },
        { key: 'attributes', name: 'Attributes', type: 'multi_reference', ref: 'attributes', role: 'relation', hint: 'values, certifications, USPs' },
        categoriesField,
        featuredField,
      ],
      inverse: [
        { collection: 'people', field: 'organization', label: 'Team' },
        { collection: 'places', field: 'organization', label: 'Places' },
        { collection: 'offerings', field: 'organization', label: 'Offerings' },
        { collection: 'events', field: 'organizer', label: 'Events' },
        { collection: 'jobs', field: 'organization', label: 'Jobs' },
        { collection: 'works', field: 'organization', label: 'Works' },
        { collection: 'articles', field: 'organization', label: 'Articles' },
        { collection: 'channels', field: 'organization', label: 'Channels' },
      ],
      samples: [
        {
          values: {
            name: 'Example Studio',
            slug: 'example-studio',
            type: 'studio',
            relationship: 'own',
            tagline: 'We turn ideas into places, products and stories.',
            summary: 'A small interdisciplinary studio for design, technology and education.',
            description:
              'Example Studio was founded in 2015 by two friends who wanted to combine craft and technology.\n\nToday the team works for clients from culture, industry and education.',
            founded: '2015-03-01',
            size: '1-10',
            email: 'hello@example.com',
            phone: '+49 30 1234567',
            website: 'https://example.com',
            legal_name: 'Example Studio GmbH',
            legal_form: 'GmbH',
            representatives: 'Mara Lindqvist, Jonas Weber',
            register_court: 'Amtsgericht Berlin-Charlottenburg',
            register_number: 'HRB 123456',
            vat_id: 'DE123456789',
            responsible_content: 'Mara Lindqvist',
            imprint: 'Liability for content: As a service provider we are responsible for our own content on these pages according to general law.\n\nOnline dispute resolution: The European Commission provides a platform at https://ec.europa.eu/consumers/odr.',
            privacy_policy: 'We only process the data that is necessary to run this website.\n\nReplace this text with your privacy policy.',
            headquarters: 'studio-berlin',
            brand: 'example-studio-brand',
            attributes: ['quality', 'iso-9001'],
            categories: ['design'],
            featured: true,
          },
          images: { logo: 'blog-productivity.webp', cover: 'blog-remote-work.webp' },
        },
        {
          values: {
            name: 'Acme Chemicals',
            slug: 'acme-chemicals',
            type: 'company',
            relationship: 'client',
            summary: 'Specialist for high-purity chemicals and certified recycling.',
            website: 'https://acme.example',
            categories: ['industry'],
          },
          images: { logo: 'blog-investing.webp' },
        },
      ],
    },

    /* --------------------------------- People ----------------------------- */
    {
      key: 'people',
      name: 'People',
      schemaOrg: 'Person',
      aliases: ['Team', 'Employees', 'Ansprechpartner', 'Artists', 'Authors', 'Contacts', 'Members'],
      description:
        'Everyone who appears on the site or is connected to it: team members, founders, artists, authors, contact persons and clients.',
      folderSlug: 'people',
      types: ['employee', 'founder', 'management', 'artist', 'doctor', 'teacher', 'contact', 'author', 'student', 'partner', 'alumni'],
      fields: [
        typeField('employee | founder | management | artist | doctor | teacher | contact | author | student | partner | alumni', 'employee'),
        { key: 'title', name: 'Title', type: 'text', role: 'hidden', hint: 'Academic title, e.g. "Dr. med."' },
        { key: 'first_name', name: 'First name', type: 'text', role: 'hidden' },
        { key: 'last_name', name: 'Last name', type: 'text', role: 'hidden' },
        { key: 'role', name: 'Role', type: 'text', role: 'subtitle', hint: 'Job title or function (LinkedIn "headline")' },
        { key: 'summary', name: 'Summary', type: 'text', role: 'summary' },
        { key: 'bio', name: 'Biography', type: 'rich_text', role: 'body' },
        { key: 'photo', name: 'Photo', type: 'image', role: 'cover' },
        { key: 'email', name: 'Email', type: 'email', role: 'meta' },
        { key: 'phone', name: 'Phone', type: 'phone', role: 'meta' },
        { key: 'website', name: 'Website', type: 'link', role: 'meta' },
        { key: 'languages', name: 'Languages', type: 'text', role: 'meta', hint: 'e.g. "German, English"' },
        { key: 'office_hours', name: 'Office hours', type: 'text', role: 'meta', hint: 'Sprechzeiten / availability' },
        { key: 'organization', name: 'Organization', type: 'reference', ref: 'organizations', role: 'relation' },
        { key: 'place', name: 'Place', type: 'reference', ref: 'places', role: 'relation' },
        { key: 'attributes', name: 'Attributes', type: 'multi_reference', ref: 'attributes', role: 'relation', hint: 'skills, values, awards' },
        categoriesField,
        featuredField,
      ],
      inverse: [
        { collection: 'articles', field: 'author', label: 'Articles' },
        { collection: 'works', field: 'creator', label: 'Works' },
        { collection: 'events', field: 'participants', label: 'Events' },
        { collection: 'offerings', field: 'contact', label: 'Offerings' },
        { collection: 'jobs', field: 'contact', label: 'Jobs' },
        { collection: 'channels', field: 'person', label: 'Channels' },
      ],
      samples: [
        {
          values: {
            name: 'Mara Lindqvist',
            slug: 'mara-lindqvist',
            type: 'founder',
            first_name: 'Mara',
            last_name: 'Lindqvist',
            role: 'Creative Director',
            summary: 'Leads design and brand work, teaches typography on the side.',
            bio: 'Mara studied communication design in Stockholm and Berlin.\n\nShe co-founded Example Studio in 2015 and is responsible for brand and editorial projects.',
            email: 'mara@example.com',
            phone: '+49 30 1234567',
            organization: 'example-studio',
            place: 'studio-berlin',
            attributes: ['quality'],
            featured: true,
          },
          images: { photo: 'profile-picture-1.webp' },
        },
        {
          values: {
            name: 'Jonas Weber',
            slug: 'jonas-weber',
            type: 'employee',
            first_name: 'Jonas',
            last_name: 'Weber',
            role: 'Technical Lead',
            summary: 'Builds the digital products and runs the workshops.',
            email: 'jonas@example.com',
            organization: 'example-studio',
            place: 'studio-berlin',
          },
          images: { photo: 'profile-picture-2.webp' },
        },
        {
          values: {
            name: 'Lena Fischer',
            slug: 'lena-fischer',
            type: 'artist',
            first_name: 'Lena',
            last_name: 'Fischer',
            role: 'Painter',
            summary: 'Large-format oil paintings on landscape and memory.',
            categories: ['art'],
          },
          images: { photo: 'profile-picture-3.webp' },
        },
      ],
    },

    /* --------------------------------- Places ----------------------------- */
    {
      key: 'places',
      name: 'Places',
      schemaOrg: 'Place',
      aliases: ['Standorte', 'Locations', 'Venues', 'Stores', 'Campus', 'Addresses'],
      description:
        'Physical locations with address and geo coordinates: offices, venues, stores, schools and studios. Events and jobs point here.',
      folderSlug: 'places',
      types: ['headquarters', 'office', 'branch', 'plant', 'warehouse', 'store', 'practice', 'ward', 'venue', 'school', 'studio', 'region', 'city'],
      fields: [
        typeField('headquarters | office | branch | plant | warehouse | store | practice | ward | venue | school | studio | region | city', 'office'),
        { key: 'street', name: 'Street', type: 'text', role: 'meta' },
        { key: 'postal_code', name: 'Postal code', type: 'text', role: 'meta' },
        { key: 'city', name: 'City', type: 'text', role: 'subtitle' },
        { key: 'region', name: 'Region', type: 'text', role: 'meta' },
        { key: 'country', name: 'Country', type: 'text', role: 'meta' },
        { key: 'latitude', name: 'Latitude', type: 'number', role: 'hidden' },
        { key: 'longitude', name: 'Longitude', type: 'number', role: 'hidden' },
        { key: 'map', name: 'Map link', type: 'link', role: 'meta' },
        { key: 'image', name: 'Image', type: 'image', role: 'cover' },
        { key: 'summary', name: 'Summary', type: 'text', role: 'summary' },
        { key: 'description', name: 'Description', type: 'rich_text', role: 'body' },
        { key: 'opening_hours', name: 'Opening hours', type: 'text', role: 'meta' },
        { key: 'email', name: 'Email', type: 'email', role: 'meta' },
        { key: 'phone', name: 'Phone', type: 'phone', role: 'meta' },
        { key: 'organization', name: 'Organization', type: 'reference', ref: 'organizations', role: 'relation' },
        { key: 'contact', name: 'Contact person', type: 'reference', ref: 'people', role: 'relation', hint: 'Site manager / first contact' },
        { key: 'offerings', name: 'Offerings', type: 'multi_reference', ref: 'offerings', role: 'relation', hint: 'What is available at this place' },
      ],
      inverse: [
        { collection: 'events', field: 'place', label: 'Events' },
        { collection: 'people', field: 'place', label: 'People' },
        { collection: 'jobs', field: 'place', label: 'Jobs' },
      ],
      samples: [
        {
          values: {
            name: 'Studio Berlin',
            slug: 'studio-berlin',
            type: 'headquarters',
            street: 'Torstraße 1',
            postal_code: '10119',
            city: 'Berlin',
            country: 'DE',
            latitude: 52.5298,
            longitude: 13.4015,
            map: 'https://maps.example/studio-berlin',
            summary: 'Our studio and workshop space in Berlin-Mitte.',
            opening_hours: 'Mon-Fri 9:00-18:00',
            email: 'hello@example.com',
            phone: '+49 30 1234567',
            organization: 'example-studio',
            contact: 'jonas-weber',
            offerings: ['brand-development', 'website-development', 'typography-course'],
          },
          images: { image: 'blog-travel.webp' },
        },
        {
          values: {
            name: 'Orangerie',
            slug: 'orangerie',
            type: 'venue',
            city: 'Munich',
            country: 'DE',
            summary: 'Exhibition venue in the English Garden.',
          },
          images: { image: 'blog-plant-diets.webp' },
        },
      ],
    },

    /* --------------------------------- Brands ----------------------------- */
    {
      key: 'brands',
      name: 'Brands',
      schemaOrg: 'Brand',
      aliases: ['Corporate Design', 'Corporate Identity', 'CI', 'CD', 'Marke', 'Design tokens'],
      description:
        'The visual identity of an organization or product line: colors, logos, fonts and claim. One organization usually has one brand, but product brands are possible too.',
      folderSlug: 'brands',
      types: ['corporate', 'product', 'campaign', 'sub_brand'],
      fields: [
        typeField('corporate | product | campaign | sub_brand', 'corporate'),
        { key: 'claim', name: 'Claim', type: 'text', role: 'subtitle' },
        { key: 'summary', name: 'Summary', type: 'text', role: 'summary' },
        { key: 'description', name: 'Brand story', type: 'rich_text', role: 'body' },
        { key: 'color_primary', name: 'Primary color', type: 'color', default: '#171717', role: 'meta' },
        { key: 'color_secondary', name: 'Secondary color', type: 'color', default: '#525252', role: 'meta' },
        { key: 'color_accent', name: 'Accent color', type: 'color', default: '#2563eb', role: 'meta' },
        { key: 'color_background', name: 'Background color', type: 'color', default: '#ffffff', role: 'meta' },
        { key: 'color_text', name: 'Text color', type: 'color', default: '#171717', role: 'meta' },
        { key: 'logo', name: 'Logo (signet)', type: 'image', role: 'cover' },
        { key: 'logo_wordmark', name: 'Logo (wordmark)', type: 'image', role: 'gallery' },
        { key: 'logo_light', name: 'Logo on dark', type: 'image', role: 'gallery' },
        { key: 'logo_dark', name: 'Logo on light', type: 'image', role: 'gallery' },
        { key: 'favicon', name: 'Favicon', type: 'image', role: 'hidden' },
        { key: 'font_heading', name: 'Heading font', type: 'text', default: 'Inter', role: 'meta' },
        { key: 'font_body', name: 'Body font', type: 'text', default: 'Inter', role: 'meta' },
        { key: 'brand_guide', name: 'Brand guide', type: 'document', role: 'meta' },
        { key: 'organization', name: 'Organization', type: 'reference', ref: 'organizations', role: 'relation' },
      ],
      inverse: [
        { collection: 'organizations', field: 'brand', label: 'Used by' },
        { collection: 'offerings', field: 'brand', label: 'Products' },
      ],
      samples: [
        {
          values: {
            name: 'Example Studio Brand',
            slug: 'example-studio-brand',
            type: 'corporate',
            claim: 'Ideas, made real.',
            summary: 'Warm neutrals with a single strong accent color.',
            color_primary: '#1f2937',
            color_secondary: '#6b7280',
            color_accent: '#f59e0b',
            color_background: '#fafaf9',
            color_text: '#111827',
            font_heading: 'Inter',
            font_body: 'Inter',
            organization: 'example-studio',
          },
          images: { logo: 'blog-productivity.webp' },
        },
      ],
    },

    /* -------------------------------- Channels ---------------------------- */
    {
      key: 'channels',
      name: 'Channels',
      schemaOrg: 'ContactPoint',
      aliases: ['Social profiles', 'Social media', 'Accounts', 'Contact channels', 'Pinterest', 'Feeds'],
      description:
        'External profiles and contact channels of people and organizations: website, Instagram, LinkedIn, WhatsApp, newsletter. Rendered as icon links.',
      folderSlug: null,
      types: ['website', 'phone', 'hotline', 'email', 'instagram', 'linkedin', 'facebook', 'youtube', 'tiktok', 'pinterest', 'x', 'github', 'mastodon', 'whatsapp', 'newsletter'],
      fields: [
        { key: 'platform', name: 'Platform', type: 'text', default: 'website', role: 'meta', hint: 'website | phone | hotline | email | instagram | linkedin | facebook | youtube | tiktok | pinterest | x | github | mastodon | whatsapp | newsletter' },
        { key: 'url', name: 'URL', type: 'link', role: 'meta' },
        { key: 'handle', name: 'Handle', type: 'text', role: 'subtitle' },
        { key: 'icon', name: 'Icon', type: 'image', role: 'cover' },
        { key: 'person', name: 'Person', type: 'reference', ref: 'people', role: 'relation' },
        { key: 'organization', name: 'Organization', type: 'reference', ref: 'organizations', role: 'relation' },
      ],
      samples: [
        { values: { name: 'Example Studio on Instagram', slug: 'example-studio-instagram', platform: 'instagram', url: 'https://instagram.com/example', handle: '@example', organization: 'example-studio' } },
        { values: { name: 'Mara on LinkedIn', slug: 'mara-linkedin', platform: 'linkedin', url: 'https://linkedin.com/in/mara', handle: 'mara-lindqvist', person: 'mara-lindqvist' } },
      ],
    },

    /* --------------------------------- Events ----------------------------- */
    {
      key: 'events',
      name: 'Events',
      schemaOrg: 'Event',
      aliases: ['Exhibitions', 'Histories', 'Milestones', 'Sessions', 'Courses', 'Termine', 'Announcements', 'Timeline'],
      description:
        'Everything that happens at a point in time. Past events form the history / timeline, future events are announcements. Milestones (founding, certifications) are events of type `milestone`.',
      folderSlug: 'events',
      types: ['exhibition', 'milestone', 'course', 'workshop', 'session', 'fair', 'talk', 'meeting', 'announcement', 'release', 'opening'],
      fields: [
        typeField('exhibition | milestone | course | workshop | session | fair | talk | meeting | announcement | release | opening', 'announcement'),
        { key: 'start', name: 'Start', type: 'date', role: 'meta' },
        { key: 'end', name: 'End', type: 'date', role: 'meta' },
        { key: 'fact', name: 'Fact', type: 'text', role: 'subtitle', hint: 'Short fact or number, e.g. "2001" or "ISO 9001"' },
        { key: 'summary', name: 'Summary', type: 'text', role: 'summary' },
        { key: 'description', name: 'Description', type: 'rich_text', role: 'body' },
        { key: 'image', name: 'Image', type: 'image', role: 'cover' },
        { key: 'gallery', name: 'Gallery', type: 'image', multiple: true, role: 'gallery' },
        { key: 'place', name: 'Place', type: 'reference', ref: 'places', role: 'relation' },
        { key: 'organizer', name: 'Organizer', type: 'reference', ref: 'organizations', role: 'relation' },
        { key: 'participants', name: 'Participants', type: 'multi_reference', ref: 'people', role: 'relation' },
        { key: 'works', name: 'Works', type: 'multi_reference', ref: 'works', role: 'relation' },
        { key: 'offering', name: 'Offering', type: 'reference', ref: 'offerings', role: 'relation', hint: 'e.g. the course this session belongs to' },
        categoriesField,
        { key: 'price', name: 'Price', type: 'number', role: 'meta' },
        { key: 'capacity', name: 'Capacity', type: 'number', role: 'meta', hint: 'Max. participants' },
        { key: 'link', name: 'Link', type: 'link', role: 'meta', hint: 'Tickets, registration, external page' },
        featuredField,
      ],
      inverse: [{ collection: 'articles', field: 'event', label: 'Articles' }],
      samples: [
        {
          values: {
            name: 'Studio founded',
            slug: 'studio-founded',
            type: 'milestone',
            start: '2015-03-01',
            fact: '2015',
            summary: 'Example Studio opens its doors in Berlin.',
            organizer: 'example-studio',
            place: 'studio-berlin',
          },
        },
        {
          values: {
            name: 'Landscape & Memory',
            slug: 'landscape-and-memory',
            type: 'exhibition',
            start: '2023-12-01',
            end: '2024-01-15',
            fact: 'Solo show',
            summary: 'Twelve new paintings by Lena Fischer.',
            description: 'The exhibition shows works from the last three years.\n\nOpening with the artist on December 1st.',
            place: 'orangerie',
            participants: ['lena-fischer'],
            works: ['morning-fog', 'field-study-iv'],
            categories: ['art'],
          },
          images: { image: 'blog-travel.webp' },
        },
        {
          values: {
            name: 'Typography Workshop',
            slug: 'typography-workshop',
            type: 'workshop',
            start: '2027-05-12',
            end: '2027-05-12',
            fact: '1 day',
            summary: 'Hands-on workshop for beginners, max. 12 participants.',
            place: 'studio-berlin',
            organizer: 'example-studio',
            participants: ['mara-lindqvist'],
            offering: 'typography-course',
            price: 390,
            capacity: 12,
            link: 'https://example.com/register',
            featured: true,
          },
          images: { image: 'blog-productivity.webp' },
        },
      ],
    },

    /* -------------------------------- Articles ---------------------------- */
    {
      key: 'articles',
      name: 'Articles',
      schemaOrg: 'Article',
      aliases: ['Blog', 'Posts', 'News', 'Seiten', 'Pages', 'Case studies', 'Press', 'FAQ', 'Testimonials', 'Guides'],
      description:
        'All editorial content. A blog post, a news item, a content page, a case study, a FAQ entry, a testimonial or a patient guide are the same thing with a different `type`: a title, a rich text body and relations. Legal texts live on the organization.',
      folderSlug: 'articles',
      types: ['post', 'news', 'page', 'case_study', 'press', 'faq', 'testimonial', 'guide', 'landing'],
      fields: [
        typeField('post | news | page | case_study | press | faq | testimonial | guide | landing', 'post'),
        { key: 'subtitle', name: 'Subtitle', type: 'text', role: 'subtitle' },
        { key: 'summary', name: 'Summary', type: 'text', role: 'summary', hint: 'Teaser / excerpt / answer preview' },
        { key: 'body', name: 'Body', type: 'rich_text', role: 'body' },
        { key: 'cover', name: 'Cover image', type: 'image', role: 'cover' },
        { key: 'gallery', name: 'Gallery', type: 'image', multiple: true, role: 'gallery' },
        { key: 'published_at', name: 'Published', type: 'date', role: 'meta' },
        { key: 'author', name: 'Author', type: 'reference', ref: 'people', role: 'relation' },
        { key: 'organization', name: 'Organization', type: 'reference', ref: 'organizations', role: 'relation', hint: 'Publisher, or the client of a case study' },
        { key: 'event', name: 'Event', type: 'reference', ref: 'events', role: 'relation' },
        { key: 'works', name: 'Works', type: 'multi_reference', ref: 'works', role: 'relation' },
        { key: 'offerings', name: 'Offerings', type: 'multi_reference', ref: 'offerings', role: 'relation' },
        categoriesField,
        { key: 'related', name: 'Related articles', type: 'multi_reference', ref: 'articles', role: 'relation' },
        { key: 'rating', name: 'Rating', type: 'number', role: 'meta', hint: '1-5, for testimonials / reviews' },
        { key: 'source', name: 'Source link', type: 'link', role: 'meta' },
        featuredField,
      ],
      inverse: [{ collection: 'articles', field: 'related', label: 'Referenced by' }],
      samples: [
        {
          values: {
            name: 'Why we build with open source',
            slug: 'why-we-build-with-open-source',
            type: 'post',
            subtitle: 'A short note on ownership and longevity',
            summary: 'Owning the stack means owning the future of a project.',
            body: 'Every website we build is a long-term relationship.\n\nOpen source tools let our clients keep full control over their content and design, independent of any vendor.',
            published_at: '2026-09-15',
            author: 'mara-lindqvist',
            organization: 'example-studio',
            categories: ['design'],
            featured: true,
          },
          images: { cover: 'blog-remote-work.webp' },
        },
        {
          values: {
            name: 'Recycling concept for Acme Chemicals',
            slug: 'recycling-concept-acme',
            type: 'case_study',
            subtitle: 'From brand to website in twelve weeks',
            summary: 'Brand refresh, new website and a recruiting campaign for a chemicals company.',
            body: 'Acme needed a modern presence that explains complex processes simply.\n\nWe developed a new wordmark, a color system and a modular website.',
            published_at: '2026-06-01',
            author: 'jonas-weber',
            organization: 'acme-chemicals',
            offerings: ['brand-development', 'website-development'],
            categories: ['industry'],
          },
          images: { cover: 'blog-investing.webp' },
        },
        {
          values: {
            name: 'How long does a website project take?',
            slug: 'how-long-does-a-website-project-take',
            type: 'faq',
            summary: 'Usually between eight and twelve weeks, depending on content.',
            body: 'A typical project runs eight to twelve weeks.\n\nThe biggest factor is how quickly texts and images are available.',
            published_at: '2026-01-10',
          },
        },
        {
          values: {
            name: 'Working with the studio was effortless',
            slug: 'testimonial-acme',
            type: 'testimonial',
            summary: 'Clear process, great results, and we can edit everything ourselves now.',
            rating: 5,
            organization: 'acme-chemicals',
            published_at: '2026-07-01',
          },
        },
      ],
    },

    /* ---------------------------------- Works ----------------------------- */
    {
      key: 'works',
      name: 'Works',
      schemaOrg: 'CreativeWork',
      aliases: ['Werke', 'Portfolio', 'Projects', 'Documents', 'Downloads', 'Media', 'Gallery', 'Pins'],
      description:
        'Things that were made: artworks, projects, photos, videos, documents and downloads. A work has a creator, optionally a price and availability, and can be shown in events and articles.',
      folderSlug: 'works',
      types: ['artwork', 'project', 'reference', 'equipment', 'document', 'download', 'photo', 'video', 'audio', 'pin'],
      fields: [
        typeField('artwork | project | reference | equipment | document | download | photo | video | audio | pin', 'project'),
        { key: 'summary', name: 'Summary', type: 'text', role: 'summary' },
        { key: 'description', name: 'Description', type: 'rich_text', role: 'body' },
        { key: 'image', name: 'Image', type: 'image', role: 'cover' },
        { key: 'gallery', name: 'Gallery', type: 'image', multiple: true, role: 'gallery' },
        { key: 'file', name: 'File', type: 'document', role: 'meta', hint: 'PDF or other download' },
        { key: 'media', name: 'Media link', type: 'link', role: 'meta', hint: 'YouTube, Vimeo, Pinterest, external page' },
        { key: 'year', name: 'Year', type: 'number', role: 'subtitle' },
        { key: 'date', name: 'Date', type: 'date', role: 'meta' },
        { key: 'medium', name: 'Medium / technique', type: 'text', role: 'meta' },
        { key: 'dimensions', name: 'Dimensions', type: 'text', role: 'meta' },
        { key: 'price', name: 'Price', type: 'number', role: 'meta' },
        { key: 'availability', name: 'Availability', type: 'text', default: 'available', role: 'meta', hint: 'available | reserved | sold | archived' },
        { key: 'creator', name: 'Creator', type: 'reference', ref: 'people', role: 'relation' },
        { key: 'organization', name: 'Organization', type: 'reference', ref: 'organizations', role: 'relation', hint: 'Studio, publisher or client' },
        categoriesField,
        featuredField,
      ],
      inverse: [
        { collection: 'events', field: 'works', label: 'Shown at' },
        { collection: 'articles', field: 'works', label: 'Articles' },
        { collection: 'offerings', field: 'works', label: 'Offerings' },
      ],
      samples: [
        {
          values: {
            name: 'Morning Fog',
            slug: 'morning-fog',
            type: 'artwork',
            summary: 'Oil on canvas, part of the Landscape & Memory series.',
            year: 2023,
            medium: 'Oil on canvas',
            dimensions: '120 x 90 cm',
            price: 3200,
            availability: 'available',
            creator: 'lena-fischer',
            categories: ['art'],
            featured: true,
          },
          images: { image: 'blog-sleep.webp' },
        },
        {
          values: {
            name: 'Field Study IV',
            slug: 'field-study-iv',
            type: 'artwork',
            year: 2022,
            medium: 'Oil on paper',
            dimensions: '40 x 30 cm',
            availability: 'sold',
            creator: 'lena-fischer',
            categories: ['art'],
          },
          images: { image: 'blog-plant-diets.webp' },
        },
        {
          values: {
            name: 'Acme website relaunch',
            slug: 'acme-website-relaunch',
            type: 'project',
            summary: 'Modular corporate website with CMS and recruiting section.',
            year: 2026,
            media: 'https://acme.example',
            creator: 'jonas-weber',
            organization: 'acme-chemicals',
            categories: ['design', 'industry'],
          },
          images: { image: 'blog-declutter.webp' },
        },
      ],
    },

    /* -------------------------------- Offerings --------------------------- */
    {
      key: 'offerings',
      name: 'Offerings',
      schemaOrg: 'Offer',
      aliases: ['Leistungen', 'Services', 'Products', 'Maßnahmen', 'Courses', 'Packages', 'Memberships'],
      description:
        'What an organization offers: services, products, courses, packages and marketing measures. Carries price, effort and the attributes (benefits, features) that describe it.',
      folderSlug: 'offerings',
      types: ['service', 'product', 'course', 'package', 'measure', 'membership', 'rental'],
      fields: [
        typeField('service | product | course | package | measure | membership | rental', 'service'),
        { key: 'summary', name: 'Summary', type: 'text', role: 'summary' },
        { key: 'description', name: 'Description', type: 'rich_text', role: 'body' },
        { key: 'icon', name: 'Icon', type: 'image', role: 'hidden' },
        { key: 'image', name: 'Image', type: 'image', role: 'cover' },
        { key: 'price', name: 'Price', type: 'number', role: 'meta' },
        { key: 'price_unit', name: 'Price unit', type: 'text', role: 'meta', hint: 'e.g. "EUR net", "per hour", "per person"' },
        { key: 'effort', name: 'Effort (hours)', type: 'number', role: 'meta' },
        { key: 'duration', name: 'Duration', type: 'text', role: 'meta', hint: 'e.g. "2 days", "12 weeks"' },
        { key: 'organization', name: 'Organization', type: 'reference', ref: 'organizations', role: 'relation' },
        { key: 'brand', name: 'Brand', type: 'reference', ref: 'brands', role: 'relation', hint: 'Product brand, if different from the corporate brand' },
        { key: 'contact', name: 'Contact', type: 'reference', ref: 'people', role: 'relation' },
        { key: 'attributes', name: 'Attributes', type: 'multi_reference', ref: 'attributes', role: 'relation', hint: 'features, benefits, goals this offering serves' },
        { key: 'works', name: 'References', type: 'multi_reference', ref: 'works', role: 'relation' },
        categoriesField,
        { key: 'link', name: 'Call to action', type: 'link', role: 'meta' },
        featuredField,
      ],
      inverse: [
        { collection: 'events', field: 'offering', label: 'Dates' },
        { collection: 'places', field: 'offerings', label: 'Available at' },
        { collection: 'articles', field: 'offerings', label: 'Articles' },
      ],
      samples: [
        {
          values: {
            name: 'Brand development',
            slug: 'brand-development',
            type: 'service',
            summary: 'Wordmark, signet, color system and brand guide.',
            description: 'We develop brands from the first sketch to the finished guide.\n\nIncludes workshops, three design directions and a complete asset set.',
            price: 120,
            price_unit: 'EUR net per hour',
            effort: 80,
            organization: 'example-studio',
            contact: 'mara-lindqvist',
            attributes: ['quality', 'personal-contact'],
            works: ['acme-website-relaunch'],
            categories: ['design'],
            featured: true,
          },
          images: { image: 'blog-meal-planning.webp' },
        },
        {
          values: {
            name: 'Website development',
            slug: 'website-development',
            type: 'service',
            summary: 'Design and build of CMS-driven websites.',
            price: 120,
            price_unit: 'EUR net per hour',
            effort: 160,
            organization: 'example-studio',
            contact: 'jonas-weber',
            attributes: ['quality'],
            works: ['acme-website-relaunch'],
            categories: ['design'],
          },
          images: { image: 'blog-declutter.webp' },
        },
        {
          values: {
            name: 'Typography course',
            slug: 'typography-course',
            type: 'course',
            summary: 'Four evenings on type, grid and rhythm.',
            price: 390,
            price_unit: 'EUR per person',
            duration: '4 evenings',
            organization: 'example-studio',
            contact: 'mara-lindqvist',
            categories: ['education'],
          },
          images: { image: 'blog-positive-thinking.webp' },
        },
      ],
    },

    /* ---------------------------------- Jobs ------------------------------ */
    {
      key: 'jobs',
      name: 'Jobs',
      schemaOrg: 'JobPosting',
      aliases: ['Stellen', 'Careers', 'Vacancies', 'Positions', 'Initiativbewerbung'],
      description:
        'Open positions with tasks, requirements and benefits. Points to the organization, the place and the contact person.',
      folderSlug: 'jobs',
      types: ['full_time', 'part_time', 'mini_job', 'apprenticeship', 'internship', 'freelance', 'volunteer', 'unsolicited'],
      fields: [
        typeField('full_time | part_time | mini_job | apprenticeship | internship | freelance | volunteer | unsolicited', 'full_time'),
        { key: 'subtitle', name: 'Subtitle', type: 'text', role: 'subtitle', hint: 'e.g. "Full-time, to strengthen our team"' },
        { key: 'summary', name: 'Summary', type: 'text', role: 'summary' },
        { key: 'tasks', name: 'Tasks', type: 'rich_text', role: 'body' },
        { key: 'requirements', name: 'Requirements', type: 'rich_text', role: 'body' },
        { key: 'cover', name: 'Cover image', type: 'image', role: 'cover' },
        { key: 'benefits', name: 'Benefits', type: 'multi_reference', ref: 'attributes', role: 'relation' },
        { key: 'organization', name: 'Organization', type: 'reference', ref: 'organizations', role: 'relation' },
        { key: 'place', name: 'Place', type: 'reference', ref: 'places', role: 'relation' },
        { key: 'contact', name: 'Contact', type: 'reference', ref: 'people', role: 'relation' },
        { key: 'posted_at', name: 'Posted', type: 'date', role: 'meta' },
        { key: 'valid_through', name: 'Valid through', type: 'date', role: 'meta' },
        { key: 'apply_link', name: 'Apply link', type: 'link', role: 'meta' },
        { key: 'apply_email', name: 'Apply email', type: 'email', role: 'meta' },
        categoriesField,
        featuredField,
      ],
      samples: [
        {
          values: {
            name: 'Frontend developer (m/f/d)',
            slug: 'frontend-developer',
            type: 'full_time',
            subtitle: 'Full-time, to strengthen our team',
            summary: 'You build accessible, fast websites together with design.',
            tasks: 'Implement websites and CMS structures\n\nWork closely with design and clients\n\nMaintain and improve existing projects',
            requirements: 'Solid HTML, CSS and JavaScript\n\nCare for details and accessibility',
            benefits: ['job-bike', 'remote-work'],
            organization: 'example-studio',
            place: 'studio-berlin',
            contact: 'jonas-weber',
            posted_at: '2026-09-01',
            valid_through: '2026-12-31',
            apply_email: 'jobs@example.com',
            featured: true,
          },
          images: { cover: 'blog-remote-work.webp' },
        },
        {
          values: {
            name: 'Unsolicited application',
            slug: 'unsolicited-application',
            type: 'unsolicited',
            subtitle: 'Did not find the right position?',
            summary: 'Tell us what you are good at and what you would like to do.',
            organization: 'example-studio',
            contact: 'mara-lindqvist',
            apply_email: 'jobs@example.com',
          },
        },
      ],
    },

    /* ------------------------------- Attributes --------------------------- */
    {
      key: 'attributes',
      name: 'Attributes',
      schemaOrg: 'DefinedTerm',
      aliases: ['Labels', 'Values', 'Werte', 'Ziele', 'Goals', 'Benefits', 'USPs', 'Zertifizierungen', 'Certifications', 'Skills', 'Awards'],
      description:
        'Reusable qualities that describe organizations, people, offerings and jobs: values, USPs, benefits, goals, skills, certifications and awards. Goals can point to other goals (`leads_to`) to build a goal graph.',
      folderSlug: 'attributes',
      types: ['value', 'usp', 'benefit', 'goal', 'certification', 'skill', 'label', 'award'],
      fields: [
        typeField('value | usp | benefit | goal | certification | skill | label | award', 'value'),
        { key: 'summary', name: 'Summary', type: 'text', role: 'summary' },
        { key: 'description', name: 'Description', type: 'rich_text', role: 'body' },
        { key: 'icon', name: 'Icon', type: 'image', role: 'cover' },
        { key: 'image', name: 'Image', type: 'image', role: 'gallery' },
        { key: 'fact', name: 'Fact', type: 'text', role: 'subtitle', hint: 'Short fact or number, e.g. "ISO 9001:2015"' },
        { key: 'date', name: 'Date', type: 'date', role: 'meta', hint: 'Certified / awarded since' },
        { key: 'valid_through', name: 'Valid through', type: 'date', role: 'meta' },
        { key: 'issuer', name: 'Issuer', type: 'reference', ref: 'organizations', role: 'relation', hint: 'Certifying body or awarding institution' },
        { key: 'document', name: 'Document', type: 'document', role: 'meta', hint: 'Certificate PDF' },
        { key: 'link', name: 'Link', type: 'link', role: 'meta' },
        { key: 'leads_to', name: 'Leads to', type: 'multi_reference', ref: 'attributes', role: 'relation', hint: 'Goal graph: this goal contributes to these goals' },
        { key: 'highlight', name: 'Highlight', type: 'boolean', default: 'false', role: 'hidden', hint: 'Use as slogan / badge' },
      ],
      inverse: [
        { collection: 'organizations', field: 'attributes', label: 'Organizations' },
        { collection: 'people', field: 'attributes', label: 'People' },
        { collection: 'offerings', field: 'attributes', label: 'Offerings' },
        { collection: 'jobs', field: 'benefits', label: 'Jobs' },
        { collection: 'attributes', field: 'leads_to', label: 'Supported by' },
      ],
      samples: [
        { values: { name: 'Quality', slug: 'quality', type: 'value', summary: 'We rather do less, but properly.', highlight: true }, images: { icon: 'blog-positive-thinking.webp' } },
        { values: { name: 'Personal contact', slug: 'personal-contact', type: 'usp', summary: 'One contact person from start to finish.' } },
        { values: { name: 'ISO 9001', slug: 'iso-9001', type: 'certification', fact: 'ISO 9001:2015', summary: 'Certified quality management.', date: '2021-01-02', valid_through: '2027-01-01', issuer: 'acme-chemicals' } },
        { values: { name: 'Job bike', slug: 'job-bike', type: 'benefit', summary: 'Leasing of a bike through the company.' } },
        { values: { name: 'Remote work', slug: 'remote-work', type: 'benefit', summary: 'Work from wherever you work best.' } },
        { values: { name: 'More applications', slug: 'more-applications', type: 'goal', summary: 'Recruiting goal', leads_to: ['growth'] } },
        { values: { name: 'Growth', slug: 'growth', type: 'goal', summary: 'Sustainable growth of the organization.' } },
      ],
    },

    /* ------------------------------- Categories --------------------------- */
    {
      key: 'categories',
      name: 'Categories',
      schemaOrg: 'DefinedTermSet',
      aliases: ['Tags', 'Topics', 'Themen', 'Industries', 'Media', 'Taxonomy'],
      description:
        'Shared taxonomy for all content. `kind` distinguishes categories, tags, topics and industries; `parent` builds a hierarchy.',
      folderSlug: 'categories',
      types: ['category', 'tag', 'topic', 'industry', 'series', 'department', 'medium'],
      fields: [
        { key: 'kind', name: 'Kind', type: 'text', default: 'category', role: 'meta', hint: 'category | tag | topic | industry | series | department | medium' },
        { key: 'summary', name: 'Summary', type: 'text', role: 'summary' },
        { key: 'icon', name: 'Icon', type: 'image', role: 'cover' },
        { key: 'color', name: 'Color', type: 'color', role: 'meta' },
        { key: 'parent', name: 'Parent', type: 'reference', ref: 'categories', role: 'relation' },
      ],
      inverse: [
        { collection: 'categories', field: 'parent', label: 'Subcategories' },
        { collection: 'places', field: 'organization', label: 'Places' },
        { collection: 'articles', field: 'categories', label: 'Articles' },
        { collection: 'works', field: 'categories', label: 'Works' },
        { collection: 'events', field: 'categories', label: 'Events' },
        { collection: 'offerings', field: 'categories', label: 'Offerings' },
        { collection: 'organizations', field: 'categories', label: 'Organizations' },
        { collection: 'people', field: 'categories', label: 'People' },
        { collection: 'jobs', field: 'categories', label: 'Jobs' },
      ],
      samples: [
        { values: { name: 'Design', slug: 'design', kind: 'category', color: '#f59e0b' } },
        { values: { name: 'Art', slug: 'art', kind: 'category', color: '#8b5cf6' } },
        { values: { name: 'Industry', slug: 'industry', kind: 'industry', color: '#10b981' } },
        { values: { name: 'Education', slug: 'education', kind: 'category', color: '#3b82f6' } },
      ],
    },
  ],

  /* ---------------------------------- Pages ------------------------------- */
  pages: [
    {
      name: 'Home',
      slug: '',
      isIndex: true,
      sections: [
        { title: 'Welcome', text: 'Replace this hero with your claim. Everything below is bound to the CMS.' },
        { title: 'Featured offerings', collection: 'offerings', limit: 6 },
        { title: 'Upcoming & recent events', collection: 'events', sortBy: 'start', sortOrder: 'desc', limit: 6 },
        { title: 'Latest articles', collection: 'articles', filter: { field: 'type', value: 'post' }, sortBy: 'published_at', sortOrder: 'desc', limit: 3 },
        { title: 'What we stand for', collection: 'attributes', filter: { field: 'type', value: 'value' }, limit: 6 },
        { title: 'Clients & partners', collection: 'organizations', filter: { field: 'relationship', value: 'client' }, limit: 8 },
      ],
    },
    {
      name: 'About',
      slug: 'about',
      sections: [
        { title: 'About us', collection: 'organizations', filter: { field: 'relationship', value: 'own' }, limit: 1 },
        { title: 'Team', collection: 'people', filter: { field: 'type', value: 'employee' } },
        { title: 'History', collection: 'events', filter: { field: 'type', value: 'milestone' }, sortBy: 'start', sortOrder: 'asc' },
        { title: 'Certifications', collection: 'attributes', filter: { field: 'type', value: 'certification' } },
        { title: 'Testimonials', collection: 'articles', filter: { field: 'type', value: 'testimonial' } },
      ],
    },
    {
      name: 'Contact',
      slug: 'contact',
      sections: [
        { title: 'Places', collection: 'places' },
        { title: 'Contact persons', collection: 'people', filter: { field: 'type', value: 'founder' } },
        { title: 'Write us', text: 'We usually answer within one working day.', form: true },
      ],
    },
    {
      name: 'FAQ',
      slug: 'faq',
      sections: [{ title: 'Frequently asked questions', collection: 'articles', filter: { field: 'type', value: 'faq' } }],
    },
    {
      name: 'Legal',
      slug: 'legal',
      sections: [
        {
          title: 'Imprint',
          collection: 'organizations',
          filter: { field: 'relationship', value: 'own' },
          fields: ['legal_name', 'representatives', 'email', 'phone', 'register_court', 'register_number', 'vat_id', 'supervisory_authority', 'chamber', 'profession_title', 'responsible_content', 'imprint'],
        },
        {
          title: 'Privacy policy',
          collection: 'organizations',
          filter: { field: 'relationship', value: 'own' },
          fields: ['privacy_policy'],
        },
        {
          title: 'Terms & conditions',
          collection: 'organizations',
          filter: { field: 'relationship', value: 'own' },
          fields: ['terms'],
        },
      ],
    },
  ],
};

/** Lookup an ontology collection by key */
export function getOntologyCollection(key: string): OntologyCollection | undefined {
  return UNIVERSAL_ONTOLOGY.collections.find((c) => c.key === key);
}
