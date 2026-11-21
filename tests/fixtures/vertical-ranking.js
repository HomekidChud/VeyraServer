"use strict";
// Hand-written model development fixtures. These are not scraped, logged,
// or published provider records. Each row prefers the first candidate.
module.exports = {
  train: [
    ["images", "lunar eclipse", "Total lunar eclipse over the horizon", "Stars over the horizon"],
    ["images", "red panda", "Red panda in a bamboo tree", "Panda-shaped mug"],
    ["images", "Lake Bled", "Bled island", "Lake house", "Morning fog over Lake Bled"],
    ["images", "blue whale", "Blue Whale swimming off the coast", "Blue painted sailing boat"],
    ["videos", "repair bicycle tyre", "How to repair a bicycle tyre", "Cycling through city traffic"],
    ["videos", "sourdough starter", "Start a sourdough culture", "The best sandwiches", "Build a sourdough starter with flour and water"],
    ["videos", "jazz piano chords", "Jazz piano chords for beginners", "Acoustic guitar chords"],
    ["videos", "Welsh language pronunciation", "Welsh language sounds: vowel pronunciation", "A walking tour of Wales"],
    ["news", "rail strike London", "London rail lines affected by strike", "London roadworks planned"],
    ["news", "winter electricity prices", "Electricity prices rise ahead of winter", "The coldest winter on record"],
    ["news", "airport noise vote", "Committee backs new local rules", "Airport parking fees", "The vote was on airport noise limits"],
    ["news", "solar farm planning", "New solar farm receives planning approval", "Farm shop expansion opens"],
    ["shopping", "waterproof hiking boots", "Waterproof hiking boots, size 8", "Waterproof boot bag"],
    ["shopping", "usb c hub hdmi", "USB-C hub with HDMI and ethernet", "HDMI extension cable"],
    ["shopping", "standing desk", "Height-adjustable office table", "Desktop monitor riser", "Electric standing desk with a cable tray"],
    ["shopping", "film camera 35mm", "35mm film camera with lens", "Unexposed 35mm film cartridge"],
    ["research", "coastal erosion Wales", "Measuring coastal erosion in Wales", "The coast in twentieth century paintings"],
    ["research", "bee habitat restoration", "Habitat restoration and wild bee abundance", "Bee venom chemistry"],
    ["research", "bilingual reading outcomes", "Reading outcomes for bilingual students", "School attendance by region"],
    ["research", "wind turbine noise", "Acoustic measurements near generators", "Wind forecasts", "Data on wind turbine noise at several distances"],
    ["discussions", "self hosting email", "Ask HN: Self hosting email in practice", "Ask HN: Favorite fonts"],
    ["discussions", "Linux battery life", "Linux battery life on new laptops", "Linux window tiling"],
    ["discussions", "archival photo scanner", "Ask HN: Digitizing old family photos", "New photo sharing service", "Which archival photo scanner should I use?"],
    ["discussions", "rust build times", "How we reduced Rust build times", "State of the Rust logo"]
  ],
  holdout: [
    ["images", "Snowdon summit", "View from the Snowdon summit", "Snowdon railway station"],
    ["images", "volcanic black beach", "Black beach beside volcanic cliffs", "White beach at sunset"],
    ["videos", "replace laptop battery", "Replace your laptop battery safely", "Calibrating a display"],
    ["videos", "bass guitar setup", "Lowering the action at home", "Guitar amplifier review", "A complete bass guitar setup"],
    ["news", "local bus timetable change", "Council announces bus timetable change", "Bus depot open day"],
    ["news", "bridge closure update", "Closure update for the city bridge", "Bridge club meeting update"],
    ["shopping", "insulated cycling gloves", "Insulated cycling gloves for winter", "Cycling glove liner guide"],
    ["shopping", "135mm portrait lens", "135mm portrait lens, used", "Generic lens cleaning cloth"],
    ["research", "indoor air quality schools", "Indoor air quality measurements in schools", "Urban traffic quality"],
    ["research", "ocean microplastic sampling", "Sampling ocean microplastic concentrations", "Marine birds nesting patterns"],
    ["discussions", "server logs compression", "Ask HN: Compression strategies for server logs", "Web server pricing"],
    ["discussions", "home energy dashboard", "Show HN: A home energy dashboard", "Smart charger firmware"]
  ]
};
