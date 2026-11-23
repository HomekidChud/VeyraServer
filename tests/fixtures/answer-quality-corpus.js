"use strict";

// Original fictional reference notes. No real service details or user data.
// Each topic stays entirely on one side of the split, including all variants.
const subjects = [
  // id, area, question, evidence 1, evidence 2, two original claims, valid and false numeric values
  ["cedar-transit", "transit", "When does boarding start and what can I bring on the Cedar shuttle?",
    "Boarding for the Cedar shuttle opens 15 minutes before the scheduled departure.",
    "Each passenger may bring one folding bicycle onto the Cedar shuttle without a separate booking.",
    "The Cedar shuttle begins boarding 15 minutes before it leaves.", "You can take one folding bicycle on the Cedar shuttle without booking it separately.", "15", "35"],
  ["northglass-library", "library", "How long can I borrow a Northglass telescope and can I renew it?",
    "The Northglass branch lends each telescope for 14 days.",
    "A Northglass telescope loan can be renewed once when nobody is waiting for the same item.",
    "A Northglass telescope loan lasts 14 days.", "You can renew a Northglass telescope once as long as no one else is waiting for it.", "14", "24"],
  ["harbourlight-workshop", "workshop", "How do I get a seat at the Harbourlight workshop?",
    "Registration for a Harbourlight workshop opens 10 days before the workshop date.",
    "The Harbourlight welcome desk gives unclaimed workshop seats to people on the waiting list.",
    "You can start registering for a Harbourlight workshop 10 days before it runs.", "If seats go unclaimed, the Harbourlight welcome desk offers them to people on the waiting list.", "10", "20"],
  ["marl-archive", "archives", "How many Marl Archive boxes can I request and what can I photograph?",
    "Visitors to the Marl Archive may request up to 4 boxes per reading-room appointment.",
    "Marl Archive visitors can photograph unrestricted papers in the reading room when they keep the flash turned off.",
    "The Marl Archive lets you request 4 boxes at most per reading-room visit.", "At the Marl Archive you may photograph unrestricted papers in the reading room, but leave the flash off.", "4", "9"],
  ["rainline-portal", "software", "How often does the Rainline portal export reports and where do they go?",
    "The Rainline portal queues an export of its reports every 6 hours.",
    "Completed Rainline exports appear in the project's Exports panel rather than being sent by email.",
    "Rainline queues its report exports once every 6 hours.", "Once a Rainline export is complete, look in the project Exports panel rather than in your inbox.", "6", "16"],
  ["cobalt-field-station", "fieldwork", "How far apart are the Cobalt field markers and which map should I use?",
    "On the Cobalt practice route, numbered markers are set 20 metres apart.",
    "The Cobalt station map marks the practice route in purple and leaves the service tracks uncoloured.",
    "The numbered markers on Cobalt's practice route are 20 metres apart.", "On the Cobalt station map, the purple line is the practice route, not one of the uncoloured service tracks.", "20", "50"],
  ["wren-records", "music", "How much rehearsal time do Wren Records members get and what equipment is included?",
    "Members can book the Wren Records rehearsal room for one block of 90 minutes.",
    "Wren Records includes a keyboard in the rehearsal room and expects musicians to bring their own microphones.",
    "A member at Wren Records can reserve one 90 minute rehearsal block.", "The Wren Records rehearsal room has a keyboard, but members need to bring microphones.", "90", "30"],
  ["thimble-market", "market", "How much space has each Thimble Market stall and when can vendors arrive?",
    "Each Thimble Market seller receives a pitch measuring 3 metres across.",
    "Thimble Market vendors can enter to set up once the loading gate opens in the morning.",
    "A seller's pitch at Thimble Market is 3 metres wide.", "Vendors may start setting up at Thimble Market after the morning opening of the loading gate.", "3", "8"],
  ["birch-exchange", "community", "How many books can I exchange at Birch and what condition should they be in?",
    "The Birch book exchange accepts at most 5 books from a participant at each visit.",
    "Books with water damage are not accepted at the Birch exchange, even if they are still readable.",
    "You can bring no more than 5 books per visit to the Birch exchange.", "The Birch book exchange does not take water-damaged books, even ones you can still read.", "5", "15"],
  ["elm-shadow-theatre", "events", "How early do doors open at Elm Shadow Theatre and where are tickets collected?",
    "Doors at Elm Shadow Theatre open 25 minutes before the scheduled performance.",
    "At Elm Shadow Theatre, prepaid tickets are collected from the desk beside the main doors.",
    "Elm Shadow Theatre opens its doors 25 minutes before the show.", "Pick up prepaid tickets at the Elm Shadow Theatre desk next to the main doors.", "25", "45"],
  ["knoll-garden", "gardening", "How many seed packets can I reserve at Knoll Garden and how do I collect them?",
    "At Knoll Garden, one household may reserve up to 8 seed packets in a season.",
    "Reserved seed packets are collected from the labelled tray inside the Knoll Garden shed.",
    "Knoll Garden sets a seasonal limit of 8 reserved seed packets per household.", "Find reserved Knoll Garden seed packets in the labelled tray inside the shed.", "8", "18"],
  ["aster-learning", "education", "How long is each Aster lesson and do learners need a login?",
    "The Aster practice course is broken into lessons of 12 minutes each.",
    "The Aster practice course lets visitors read lessons without a login, but saving progress requires an account.",
    "Each lesson in the Aster practice course lasts 12 minutes.", "You can read Aster practice lessons without logging in, but you need an account to save progress.", "12", "22"],
  ["tessera-museum", "museum", "How many visitors fit in a Tessera tour and which entrance do they use?",
    "The Tessera Museum allows up to 16 visitors on each guided tour.",
    "Guided tour visitors should meet at the Tessera Museum entrance next to the blue courtyard.",
    "A guided tour at Tessera Museum has room for 16 visitors.", "For a guided tour, meet at the Tessera Museum entrance beside the blue courtyard.", "16", "26"],
  ["lantern-ferry", "ferry", "When does booking close for the Lantern ferry and can I change sailings?",
    "Online booking for a Lantern ferry crossing closes 40 minutes before departure.",
    "Lantern ferry passengers can request a change of sailing at the pier ticket desk when seats remain on the new crossing.",
    "The Lantern ferry stops taking online bookings 40 minutes before it leaves.", "If the new sailing has space, you can ask the Lantern ferry ticket desk at the pier to move your booking.", "40", "70"],
  ["pine-orchard", "food", "How many bags can I fill at Pine Orchard and which fruit can I pick?",
    "Pickers at Pine Orchard can fill up to 2 bags per ticket.",
    "Pine Orchard visitors may only pick fruit from trees with a green ribbon.",
    "A Pine Orchard ticket lets you fill up to 2 bags.", "Only pick from Pine Orchard trees marked with a green ribbon.", "2", "7"],
  ["slate-observatory", "astronomy", "How long is Slate Observatory's visitor session and what happens when it rains?",
    "A Slate Observatory visitor session lasts 75 minutes.",
    "When it rains, Slate Observatory moves its visitor session indoors and gives a guide-led talk.",
    "Slate Observatory schedules 75 minutes for a visitor session.", "If it rains, the Slate Observatory session becomes an indoor talk led by a guide.", "75", "95"],
  ["fern-heritage", "walking", "How far is the Fern Heritage trail and where does it finish?",
    "The full Fern Heritage walking trail is 7 kilometres long.",
    "The Fern Heritage trail ends at the old clock house next to the town square.",
    "The complete Fern Heritage walk covers 7 kilometres.", "The Fern Heritage trail finishes at the old clock house beside the town square.", "7", "17"],
  ["cloudbank-storage", "file-storage", "When does Cloudbank delete items in the bin and can I restore them?",
    "Cloudbank automatically deletes files that have spent 28 days in the bin.",
    "Before automatic deletion, Cloudbank users can use the Restore button to move an item back to its original folder.",
    "Cloudbank removes a file after it has spent 28 days in the bin.", "Before Cloudbank deletes it, use Restore to return the file to its original folder.", "28", "38"],
  ["ochre-craft-room", "crafts", "How many looms are available and what supplies does Ochre provide?",
    "The Ochre craft room has 11 looms available for each group session.",
    "The Ochre craft room supplies thread but asks visitors to bring a small pair of scissors.",
    "Each Ochre craft room group session can use 11 looms.", "Thread is supplied in the Ochre craft room, but visitors need to bring small scissors.", "11", "19"],
  ["silvertrail-maps", "mapping", "How often does Silvertrail refresh its maps and can I download one?",
    "Silvertrail publishes a new version of its maps every 21 days.",
    "A Silvertrail account lets visitors download maps for offline viewing.",
    "Silvertrail releases updated maps every 21 days.", "You can download Silvertrail maps for offline use if you have an account.", "21", "51"]
];

const holdoutIds = new Set(["pine-orchard", "slate-observatory", "fern-heritage", "cloudbank-storage", "ochre-craft-room", "silvertrail-maps"]);

function makeScenario([id, domain, question, noteA, noteB, claimA, claimB, value, wrongValue]) {
  const evidence = [noteA, noteB].map((note, index) => ({
    id: `S${index + 1}`, url: `https://${id}-${index ? "desk" : "handbook"}.invalid/`,
    matched: [note], verificationSentences: [note],
    passages: [{ text: note }]
  }));
  const cite = (claim, citeId) => `${claim} [${citeId}]`;
  const good = `${cite(claimA, "S1")} ${cite(claimB, "S2")}`;
  const changed = claimA.replace(new RegExp(`\\b${value}\\b`), wrongValue);
  if (changed === claimA) throw new Error(`Bad numeric counterexample: ${id}`);
  return { id, domain, question, evidence, split: holdoutIds.has(id) ? "holdout" : "train", candidates: [
    { kind: "grounded", helpful: true, text: good },
    { kind: "missing-citations", helpful: false, text: `${claimA} ${claimB}` },
    { kind: "swapped-citations", helpful: false, text: `${cite(claimA, "S2")} ${cite(claimB, "S1")}` },
    { kind: "invented-citation", helpful: false, text: `${cite(claimA, "S1")} ${cite(claimB, "S9")}` },
    { kind: "wrong-number", helpful: false, text: `${cite(changed, "S1")} ${cite(claimB, "S2")}` },
    { kind: "unsupported-claim", helpful: false, text: `${good} Members also receive a free gift card after each visit. [S2]` },
    { kind: "verbatim", helpful: false, text: `${cite(noteA, "S1")} ${cite(noteB, "S2")}` },
    { kind: "format-noise", helpful: false, text: `### Answer\n- ${cite(claimA, "S1")}\n- ${cite(claimB, "S2")}` },
    { kind: "incomplete", helpful: false, text: cite(claimA, "S1") }
  ] };
}

module.exports = subjects.map(makeScenario);
