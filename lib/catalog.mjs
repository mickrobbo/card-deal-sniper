// Pokemon TCG English sets (newest first, grouped by era) and sealed product types.
// Used by the dashboard's dropdowns. Editable in Settings > Advanced (config.catalog)
// so new sets can be added without a code change.

export const SET_GROUPS = [
  { era: "Mega Evolution", sets: [
    "Delta Reign", "30th Celebration", "Pitch Black", "Chaos Rising", "Perfect Order",
    "Ascended Heroes", "Phantasmal Flames", "Mega Evolution",
  ] },
  { era: "Scarlet & Violet", sets: [
    "White Flare", "Black Bolt", "Destined Rivals", "Journey Together", "Prismatic Evolutions",
    "Surging Sparks", "Stellar Crown", "Shrouded Fable", "Twilight Masquerade", "Temporal Forces",
    "Paldean Fates", "Paradox Rift", "151", "Obsidian Flames", "Paldea Evolved", "Scarlet & Violet",
  ] },
  { era: "Sword & Shield", sets: [
    "Crown Zenith", "Silver Tempest", "Lost Origin", "Pokemon GO", "Astral Radiance", "Brilliant Stars",
    "Fusion Strike", "Celebrations", "Evolving Skies", "Chilling Reign", "Battle Styles", "Shining Fates",
    "Vivid Voltage", "Champion's Path", "Darkness Ablaze", "Rebel Clash", "Sword & Shield",
  ] },
  { era: "Sun & Moon", sets: [
    "Cosmic Eclipse", "Hidden Fates", "Unified Minds", "Unbroken Bonds", "Detective Pikachu", "Team Up",
    "Lost Thunder", "Dragon Majesty", "Celestial Storm", "Forbidden Light", "Ultra Prism",
    "Crimson Invasion", "Shining Legends", "Burning Shadows", "Guardians Rising", "Sun & Moon",
  ] },
  { era: "XY", sets: [
    "Evolutions", "Steam Siege", "Fates Collide", "Generations", "BREAKpoint", "BREAKthrough",
    "Ancient Origins", "Roaring Skies", "Double Crisis", "Primal Clash", "Phantom Forces",
    "Furious Fists", "Flashfire", "XY",
  ] },
  { era: "Black & White", sets: [
    "Legendary Treasures", "Plasma Blast", "Plasma Freeze", "Plasma Storm", "Boundaries Crossed",
    "Dragon Vault", "Dragons Exalted", "Dark Explorers", "Next Destinies", "Noble Victories",
    "Emerging Powers", "Black & White",
  ] },
  { era: "HeartGold & SoulSilver", sets: [
    "Call of Legends", "Triumphant", "Undaunted", "Unleashed", "HeartGold & SoulSilver",
  ] },
  { era: "Platinum", sets: ["Arceus", "Supreme Victors", "Rising Rivals", "Platinum"] },
  { era: "Diamond & Pearl", sets: [
    "Stormfront", "Legends Awakened", "Majestic Dawn", "Great Encounters", "Secret Wonders",
    "Mysterious Treasures", "Diamond & Pearl",
  ] },
  { era: "EX", sets: [
    "Power Keepers", "Dragon Frontiers", "Crystal Guardians", "Holon Phantoms", "Legend Maker",
    "Delta Species", "Unseen Forces", "Emerald", "Deoxys", "Team Rocket Returns",
    "FireRed & LeafGreen", "Hidden Legends", "Team Magma vs Team Aqua", "Dragon", "Sandstorm",
    "Ruby & Sapphire",
  ] },
  { era: "WOTC classic", sets: [
    "Skyridge", "Aquapolis", "Expedition", "Legendary Collection", "Neo Destiny", "Neo Revelation",
    "Neo Discovery", "Neo Genesis", "Gym Challenge", "Gym Heroes", "Team Rocket", "Base Set 2",
    "Fossil", "Jungle", "Base Set",
  ] },
];

// aliases = the different ways sellers write it in listing titles (used for comp matching)
export const PRODUCTS = [
  { group: "Boxes", name: "Booster Box", aliases: ["booster box", "booster display", "display box"] },
  { group: "Boxes", name: "Booster Box Case", aliases: ["booster box case", "sealed case"] },
  { group: "Boxes", name: "Elite Trainer Box", aliases: ["elite trainer box", "etb"] },
  { group: "Boxes", name: "Pokemon Center Elite Trainer Box", aliases: ["pokemon center elite trainer box", "pokemon center etb", "pc etb"] },
  { group: "Boxes", name: "Booster Bundle", aliases: ["booster bundle"] },
  { group: "Boxes", name: "Build & Battle Box", aliases: ["build battle box", "build and battle box"] },
  { group: "Boxes", name: "Build & Battle Stadium", aliases: ["build battle stadium", "build and battle stadium"] },
  { group: "Collections", name: "Ultra-Premium Collection", aliases: ["ultra premium collection", "upc"] },
  { group: "Collections", name: "Super-Premium Collection", aliases: ["super premium collection", "spc"] },
  { group: "Collections", name: "Premium Collection", aliases: ["premium collection"] },
  { group: "Collections", name: "Special Collection", aliases: ["special collection"] },
  { group: "Collections", name: "Collection Box", aliases: ["collection box"] },
  { group: "Collections", name: "Poster Collection", aliases: ["poster collection"] },
  { group: "Collections", name: "Binder Collection", aliases: ["binder collection"] },
  { group: "Collections", name: "Pin Collection", aliases: ["pin collection"] },
  { group: "Collections", name: "Tech Sticker Collection", aliases: ["tech sticker collection", "sticker collection"] },
  { group: "Collections", name: "Surprise Box", aliases: ["surprise box"] },
  { group: "Collections", name: "Accessory Pouch", aliases: ["accessory pouch"] },
  { group: "Tins", name: "Tin", aliases: ["tin"] },
  { group: "Tins", name: "Mini Tin", aliases: ["mini tin"] },
  { group: "Packs", name: "Booster Pack", aliases: ["booster pack"] },
  { group: "Packs", name: "Sleeved Booster Pack", aliases: ["sleeved booster"] },
  { group: "Packs", name: "3-Pack Blister", aliases: ["3 pack blister", "3 booster blister", "three pack blister"] },
  { group: "Packs", name: "Checklane Blister", aliases: ["checklane blister", "single blister"] },
  { group: "Decks", name: "Battle Deck", aliases: ["battle deck"] },
  { group: "Decks", name: "League Battle Deck", aliases: ["league battle deck"] },
  { group: "Decks", name: "Theme Deck", aliases: ["theme deck"] },
];

export const DEFAULT_CATALOG = { set_groups: SET_GROUPS, products: PRODUCTS };
