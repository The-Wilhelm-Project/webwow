# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Universal website ontology template (`lib/universal-ontology.ts`): organizations, people, places, brands, channels, events, articles, works, offerings, jobs, attributes and categories with relations, sample data, folders, list/detail wireframe pages, SEO bindings and legal pages; available from the CMS menu, `npm run template:universal`, `POST /webwow/api/templates/universal` and the MCP tools `get_universal_ontology` / `apply_universal_template`

### Fixed

- Nested reference resolution no longer merges a referenced item's own field values into the parent item (wrong values when a reference chain loops back into the same collection)
- Reference resolution is memoized per request and capped at 3 hops, which turns multi-minute renders of densely linked content into sub-second renders

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
