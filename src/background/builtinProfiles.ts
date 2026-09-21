/**
 * Built-in profiles, pre-compiled so they don't need an LLM call.
 * Users can enable, duplicate, or edit them from the side panel.
 */
import type { CompiledProfile } from "../shared/types";

const COMPILER = { model: "builtin", compiledAt: "2026-09-21T00:00:00.000Z", sourceHash: "builtin" };

export const LOCATIONS_PROFILE: CompiledProfile = {
  id: "builtin_locations",
  version: 1,
  name: "Locations and businesses",
  enabled: false,
  builtin: true,
  source: {
    name: "Locations and businesses",
    extract: "Physical addresses and the names of venues, shops, restaurants, and other businesses that can be placed on a map. Ignore corporate mailing addresses and legal notices.",
    matchPatterns: [],
    resolvers: [{ type: "geocode", when: { field: "kind", in: ["street_address", "landmark", "business_name"] }, config: { provider: "nominatim", verify: true } }],
  },
  scope: { matchPatterns: [], siteOverrides: {}, pageGateThreshold: 0.5 },
  selection: {
    sources: ["structured_data", "semantic_html", "map_embeds", "text_patterns", "headings", "link_text", "list_items"],
    structuredTypes: ["Place", "LocalBusiness", "Restaurant", "Store", "Organization", "PostalAddress", "Event", "Hotel", "CafeOrCoffeeShop", "TouristAttraction"],
    maxCandidates: 200,
    contextChars: 120,
  },
  questions: [
    {
      id: "resolve",
      type: "noul",
      instructions: "Does candidate {cid} describe a specific physical place or business that could be placed on a map?",
      criteria: {
        true: "A street address, named venue, branch location, or landmark.",
        false: "A person, a product, a region with no specific location, a corporate mailing address in legal text, or unrelated text.",
      },
    },
    {
      id: "kind",
      type: "choice",
      instructions: "What does candidate {cid} describe?",
      criteria: {
        street_address: "A postal address with street and number.",
        business_name: "The name of a company, shop, or venue without an address.",
        city_or_region: "A city, state, country, or neighbourhood.",
        landmark: "A named park, monument, station, or building.",
        not_a_place: "None of the above.",
      },
    },
  ],
  decision: { acceptField: "resolve", acceptThreshold: 0.85, reviewThreshold: 0.5 },
  resolvers: [{ type: "geocode", when: { field: "kind", in: ["street_address", "landmark", "business_name"] }, config: { provider: "nominatim", verify: true } }],
  compiler: COMPILER,
};

export const EVENTS_PROFILE: CompiledProfile = {
  id: "builtin_events",
  version: 1,
  name: "Events",
  enabled: false,
  builtin: true,
  source: {
    name: "Events",
    extract: "Event names together with their dates and venues: concerts, talks, meetups, exhibitions, screenings, and similar scheduled happenings.",
    matchPatterns: [],
    pageTypeHint: "pages that list or describe upcoming events",
    resolvers: [{ type: "none", when: { field: "is_event" }, config: {} }],
  },
  scope: {
    matchPatterns: [],
    siteOverrides: {},
    pageGate: {
      type: "noul",
      instructions: "Does this page list or describe one or more scheduled events such as concerts, talks, meetups, or exhibitions?",
      criteria: {
        true: "An events calendar, event detail page, venue programme, or listing of things happening on specific dates.",
        false: "A news article, product page, company homepage, or other page with no scheduled events.",
      },
    },
    pageGateThreshold: 0.5,
  },
  selection: {
    sources: ["structured_data", "headings", "list_items", "table_cells", "text_patterns"],
    structuredTypes: ["Event", "MusicEvent", "TheaterEvent", "Festival", "ExhibitionEvent", "ScreeningEvent", "SocialEvent", "EducationEvent"],
    textPatterns: [
      String.raw`\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[^\n]{0,80}`,
      String.raw`\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?[^\n]{0,80}`,
      String.raw`\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b[^\n]{0,80}`,
    ],
    maxCandidates: 150,
    contextChars: 160,
  },
  questions: [
    {
      id: "is_event",
      type: "noul",
      instructions: "Does candidate {cid} name or describe a specific scheduled event?",
      criteria: {
        true: "A named event, or a date/time line clearly attached to an event such as a concert, talk, meetup, or exhibition.",
        false: "Navigation, a generic heading, a publication date of an article, an opening-hours line, or unrelated text.",
      },
    },
    {
      id: "part",
      type: "choice",
      instructions: "Which part of an event does candidate {cid} primarily give?",
      criteria: {
        name: "The event's title or name.",
        date_time: "A date, time, or date range.",
        venue: "A venue or location where it happens.",
        combined: "Two or more of name, date, and venue together.",
        none: "None of the above.",
      },
    },
  ],
  decision: { acceptField: "is_event", acceptThreshold: 0.85, reviewThreshold: 0.5 },
  resolvers: [{ type: "none", when: { field: "is_event" }, config: {} }],
  compiler: COMPILER,
};

export const CONTACTS_PROFILE: CompiledProfile = {
  id: "builtin_contacts",
  version: 1,
  name: "Contact details",
  enabled: false,
  builtin: true,
  source: {
    name: "Contact details",
    extract: "Email addresses and phone numbers, with the role they belong to (sales, support, press, or personal).",
    matchPatterns: [],
    resolvers: [{ type: "none", when: { field: "is_contact" }, config: {} }],
  },
  scope: { matchPatterns: [], siteOverrides: {}, pageGateThreshold: 0.5 },
  selection: {
    sources: ["structured_data", "text_patterns", "link_text", "list_items", "table_cells"],
    structuredTypes: ["ContactPoint", "Organization", "Person", "LocalBusiness"],
    textPatterns: [
      String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`,
      String.raw`(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b`,
    ],
    maxCandidates: 120,
    contextChars: 100,
  },
  questions: [
    {
      id: "is_contact",
      type: "noul",
      instructions: "Is candidate {cid} an email address or phone number that someone could use to contact a person or organisation?",
      criteria: {
        true: "A syntactically valid email address or phone number presented as a way to get in touch.",
        false: "An order number, a date, an ID, a placeholder like name@example.com, or unrelated text.",
      },
    },
    {
      id: "role",
      type: "choice",
      instructions: "Which role does the contact in candidate {cid} belong to?",
      criteria: {
        sales: "Sales, bookings, reservations, or new-business enquiries.",
        support: "Customer support, help desk, or technical support.",
        press: "Press, media, or public relations.",
        personal: "An individual person's own contact detail.",
        other: "General or unknown role.",
      },
    },
    {
      id: "channel",
      type: "choice",
      instructions: "What kind of contact detail is candidate {cid}?",
      criteria: { email: "An email address.", phone: "A telephone or fax number.", other: "Neither." },
    },
  ],
  decision: { acceptField: "is_contact", acceptThreshold: 0.85, reviewThreshold: 0.5 },
  resolvers: [{ type: "none", when: { field: "is_contact" }, config: {} }],
  compiler: COMPILER,
};

export const PRICES_PROFILE: CompiledProfile = {
  id: "builtin_prices",
  version: 1,
  name: "Prices",
  enabled: false,
  builtin: true,
  source: {
    name: "Prices",
    extract: "Product or service names together with their listed prices.",
    matchPatterns: [],
    resolvers: [{ type: "none", when: { field: "is_price" }, config: {} }],
  },
  scope: { matchPatterns: [], siteOverrides: {}, pageGateThreshold: 0.5 },
  selection: {
    sources: ["structured_data", "text_patterns", "table_cells", "list_items", "headings"],
    structuredTypes: ["Product", "Offer", "AggregateOffer", "Service", "MenuItem"],
    textPatterns: [String.raw`(?:[$€£¥]\s?\d[\d,.]*|\d[\d,.]*\s?(?:USD|EUR|GBP|CHF|JPY|€|\$|£))(?:\s?(?:/|per)\s?\w+)?`],
    maxCandidates: 200,
    contextChars: 120,
  },
  questions: [
    {
      id: "is_price",
      type: "noul",
      instructions: "Does candidate {cid} state the price of a specific product or service, or name a product that has a listed price next to it?",
      criteria: {
        true: "A monetary amount attached to a product, plan, menu item, or service, or the product name it belongs to.",
        false: "A total, tax, shipping fee, salary, statistic, or a number that is not a price.",
      },
    },
    {
      id: "part",
      type: "choice",
      instructions: "What does candidate {cid} contain?",
      criteria: {
        price_only: "A monetary amount without the product name.",
        name_only: "A product or service name without a price.",
        name_and_price: "Both a name and its price.",
        neither: "Neither.",
      },
    },
  ],
  decision: { acceptField: "is_price", acceptThreshold: 0.85, reviewThreshold: 0.5 },
  resolvers: [{ type: "none", when: { field: "is_price" }, config: {} }],
  compiler: COMPILER,
};

export const BUILTIN_PROFILES: CompiledProfile[] = [LOCATIONS_PROFILE, EVENTS_PROFILE, CONTACTS_PROFILE, PRICES_PROFILE];
