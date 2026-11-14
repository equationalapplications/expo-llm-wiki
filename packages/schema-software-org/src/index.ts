import type { OntologyManifest } from '@equationalapplications/core-llm-wiki';

export type { OntologyManifest, OntologyNodeType, OntologyEdgeType } from '@equationalapplications/core-llm-wiki';

/**
 * Custom minimal ontology for an executive agent operating on behalf of a
 * software organization: 21 node types, 42 edges. Superset of the warm-agent
 * manifest (`schema-org-llm-wiki`), whose 9 node types and 28 edges are copied
 * verbatim (D2) — with one deliberate override on `product` (D8) — plus 3
 * software-org base types, 3 `creativework` subtypes, the abstract `statement`
 * with its four kinds (`rule`, `decision`, `lesson`, `trap`), `area`, and 14
 * new edges.
 *
 * Properties live in the description strings (D3): `buildPromptContext`
 * JSON-serializes the manifest into the classification prompt, so description
 * text reaches the model verbatim and no core change is needed. There is no
 * property inheritance (D4) — every subtype lists its own complete set.
 *
 * The text is organization-neutral: it says "the organization", never a
 * specific company, so any software org can adopt it unmodified.
 */
export const schemaSoftwareOrgManifest: OntologyManifest = {
  node_types: [
    // Warm-agent types — copied verbatim from schemaOrgWarmAgentManifest.
    // Do not abridge: descriptions are the classification signal (D2/D3).
    { type: 'person', description: "A person—friend, family member, colleague, or public figure. Use this for any individual in the user's social, professional, or knowledge network." },
    { type: 'organization', description: 'A company, nonprofit, club, sports team, or institution. Covers businesses, schools, local shops, and communities.' },
    { type: 'place', description: 'A geographic location, address, landmark, or venue. Use for cities, buildings, parks, restaurants, or any physical or conceptual location.' },
    { type: 'event', description: 'A scheduled or past gathering, meeting, conference, concert, or celebration. Links attendees and organizers to the event.' },
    { type: 'project', description: 'A multi-step initiative, goal, or endeavor. Use for personal projects, learning goals, business initiatives, or long-term objectives.' },
    { type: 'action', description: 'An individual task, chore, step, or completed action. Links to a parent Project and assigns responsibility to a Person.' },
    { type: 'creativework', description: 'A book, movie, article, song, recipe, blog post, or other creative content. Captures media the user consumes, learns from, or creates.' },
    { type: 'review', description: 'A personal review, opinion, or evaluation. The implicit subject is always the owning character—use to review a book, restaurant, place, product, or experience. Rating values stay inside the fact content.' },
    // D8: intentional divergence from the warm-agent original — the upstream
    // row claims "and software", which pulls the org's own repositories here.
    { type: 'product', description: 'A physical item, software tool, or device owned or under consideration. Covers electronics, vehicles, and household items. For software the organization builds, ships, or maintains, use software_application instead; for a hosted capability it consumes or operates, use service.' },
    // Software-org base types (no parent_type, no children — D5)
    { type: 'software_application', description: 'Software the organization itself builds, ships, or maintains — its own portfolio codebase. Not third-party software the organization merely uses (that is product), and not a running hosted capability (that is service). Expected frontmatter properties: repo_url, version, install_path, status (active/deprecated/in_dev).' },
    { type: 'service', description: "A running hosted capability the organization consumes or operates, vendor-run or self-run — databases, APIs, CI, auth, monitoring. Distinct from software_application (the codebase the organization ships) and product (third-party tools it owns). The organization's own backend is a software_application as source and a service as a deployed dependency. Expected frontmatter properties: provider, dashboard_url, status, tier (critical/important/optional)." },
    { type: 'role', description: 'A functional role a person fills within the organization. Expected frontmatter properties: role_name, scope, capabilities.' },
    // Software-org concrete types (one level under creativework)
    { type: 'design_spec', parent_type: 'creativework', description: 'A technical or product design specification. Expected frontmatter properties: status (draft/approved/implemented/superseded), spec_for (software_application or service slug), branch.' },
    { type: 'procedure', parent_type: 'creativework', description: 'A checklist, workflow, or how-to document. Expected frontmatter properties: trigger (when to use it), last_reviewed, applies_to (software_application or service slug).' },
    { type: 'reference_doc', parent_type: 'creativework', description: 'A product doc, service description, or architecture reference. Expected frontmatter properties: source_url, application (software_application slug).' },
    // Statement kinds: one abstract parent, four content-defined children.
    { type: 'statement', description: 'Abstract parent of the four statement kinds (rule, decision, lesson, trap); classify a fact as one of the four kinds, never as `statement`. The four kinds attach with `about` to an `area`, the `software_application`, or the `organization`, and the `about` rows declared with source `statement` apply to every kind.' },
    { type: 'rule', parent_type: 'statement', description: 'A situation, and what to do in it. Each rule holds one claim.' },
    { type: 'decision', parent_type: 'statement', description: 'What was chosen, what was rejected, and why. Each decision holds one claim.' },
    { type: 'lesson', parent_type: 'statement', description: 'What went wrong, and what to do differently. Each lesson holds one claim.' },
    { type: 'trap', parent_type: 'statement', description: 'A likely wrong assumption, and the fact that corrects it. Each trap holds one claim.' },
    { type: 'area', description: "A named part of a `software_application`, such as deploy or billing. Expected frontmatter properties: name, patterns_file (path, inside the host repo, of the file that holds the area's file globs — a pointer, not a copy)." },
  ],
  edge_types: [
    // Warm-agent edges — copied verbatim from schemaOrgWarmAgentManifest (D2).
    { type: 'knows', source_type: 'person', target_type: 'person', description: 'Friendship, acquaintance, or general connection between two people.' },
    { type: 'spouse', source_type: 'person', target_type: 'person', description: 'Spousal or long-term partner relationship.' },
    { type: 'parent', source_type: 'person', target_type: 'person', description: 'A parent of this person: the source is the child, the target is the parent.' },
    { type: 'worksFor', source_type: 'person', target_type: 'organization', description: 'Employment or primary professional affiliation.' },
    { type: 'memberOf', source_type: 'person', target_type: 'organization', description: 'Membership in clubs, associations, or communities.' },
    { type: 'homeLocation', source_type: 'person', target_type: 'place', description: 'Primary residence.' },
    { type: 'workLocation', source_type: 'person', target_type: 'place', description: 'Workplace or primary work location.' },
    { type: 'location', source_type: 'event', target_type: 'place', description: 'Venue or geographic location of an event.' },
    { type: 'location', source_type: 'organization', target_type: 'place', description: 'Physical headquarters or primary location.' },
    { type: 'containedInPlace', source_type: 'place', target_type: 'place', description: 'Hierarchical location: the source place is inside the target place (e.g., Paris is contained in France).' },
    { type: 'subOrganization', source_type: 'project', target_type: 'project', description: 'Nested project hierarchy: the target is a sub-project contained in the source project.' },
    { type: 'object', source_type: 'action', target_type: 'project', description: 'Project this task belongs to; the object the action advances.' },
    { type: 'agent', source_type: 'action', target_type: 'person', description: 'Person responsible for or performing the action.' },
    { type: 'attendee', source_type: 'event', target_type: 'person', description: 'Person attending or participating in the event.' },
    { type: 'organizer', source_type: 'event', target_type: 'person', description: 'Person who organized the event.' },
    { type: 'organizer', source_type: 'event', target_type: 'organization', description: 'Organization hosting the event.' },
    { type: 'author', source_type: 'creativework', target_type: 'person', description: 'Author, creator, artist, or filmmaker.' },
    { type: 'publisher', source_type: 'creativework', target_type: 'organization', description: 'Publisher, platform, studio, or distributor.' },
    { type: 'about', source_type: 'creativework', target_type: 'person', description: 'Content centered on a specific person.' },
    { type: 'about', source_type: 'creativework', target_type: 'organization', description: 'Content centered on a company, institution, or group.' },
    { type: 'about', source_type: 'creativework', target_type: 'place', description: 'Content centered on a location (travel guide, history).' },
    { type: 'about', source_type: 'creativework', target_type: 'event', description: 'Content centered on an event (documentary, article).' },
    { type: 'itemReviewed', source_type: 'review', target_type: 'creativework', description: 'The book, movie, article, or other work this review evaluates.' },
    { type: 'itemReviewed', source_type: 'review', target_type: 'organization', description: 'The business, restaurant, or institution this review evaluates.' },
    { type: 'itemReviewed', source_type: 'review', target_type: 'place', description: 'The venue, park, or location this review evaluates.' },
    { type: 'itemReviewed', source_type: 'review', target_type: 'event', description: 'The event this review evaluates.' },
    { type: 'itemReviewed', source_type: 'review', target_type: 'product', description: 'The tool, device, or product this review evaluates.' },
    { type: 'owns', source_type: 'person', target_type: 'product', description: 'Item owned by the person (electronics, vehicles, etc.).' },
    // Software-org edges (14, new)
    { type: 'dependsOn', source_type: 'software_application', target_type: 'service', description: 'This software application depends on this service.' },
    { type: 'specifies', source_type: 'design_spec', target_type: 'software_application', description: 'Spec is about this software application.' },
    { type: 'specifies', source_type: 'design_spec', target_type: 'service', description: 'Spec is about this service.' },
    { type: 'documents', source_type: 'procedure', target_type: 'software_application', description: 'Procedure applies to this software application.' },
    { type: 'documents', source_type: 'procedure', target_type: 'service', description: 'Procedure applies to this service.' },
    // One row covers every creativework subtype on both sides: matching is
    // parent-aware on source and target alike, exact-first (D6).
    { type: 'supersedes', source_type: 'creativework', target_type: 'creativework', description: 'This document replaces an older one.' },
    { type: 'hasRole', source_type: 'person', target_type: 'role', description: 'Person fills this role.' },
    { type: 'operates', source_type: 'role', target_type: 'software_application', description: 'Role operates this software application.' },
    { type: 'provides', source_type: 'organization', target_type: 'service', description: 'Organization provides this service.' },
    { type: 'maintains', source_type: 'person', target_type: 'software_application', description: 'Person maintains this software application.' },
    { type: 'partOf', source_type: 'area', target_type: 'software_application', description: 'This area is a named part of this software application.' },
    { type: 'about', source_type: 'statement', target_type: 'area', description: 'This statement (any of the four kinds) concerns this area.' },
    { type: 'about', source_type: 'statement', target_type: 'software_application', description: 'This statement (any of the four kinds) concerns this software application as a whole.' },
    { type: 'about', source_type: 'statement', target_type: 'organization', description: 'This statement (any of the four kinds) concerns the organization.' },
  ],
};
