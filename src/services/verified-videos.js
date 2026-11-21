"use strict";

const { unicodeWords } = require("./search-language");

// Titles, publishers and IDs verified through YouTube oEmbed. Only search
// metadata is stored here, not video content. These are a small offline lane.
const COLLECTION = [
  ["bTEvysY5FLE", "How to Fix a Leaking Tap | DIY with Curran Plumbing & Jason Hodges", "Curran Plumbing, Electrical, Heating and Air", "Repair a leaking tap or dripping faucet by replacing its washer and seals."],
  ["dcbddeLlSM8", "How To Fix a Dripping Tap - Washer Change - Plumbing Tips", "plumberparts", "A leaking bathroom or kitchen tap: isolate the water and replace the worn tap washer."],
  ["zMH61Yabdj0", "How to Repair a Leaking Faucet | This Old House", "This Old House", "Repair a leaking sink tap or faucet with a replacement washer or cartridge."],
  ["nioujJogJZw", "Crispy Dosa with Cast Iron Dosa Pan & Wet Grinder - Pro Tips | Right Way to Make Crisp Dosa Batter", "Hebbars Kitchen", "Traditional crispy dosa recipe with ground rice and lentil batter."],
  ["J75VQSxOtdo", "cripsy roasted hotel style masala dosa recipe | ಹೋಟೆಲ್ ಮಸಾಲ ದೋಸೆ | how to make crispy masale dose", "Hebbars Kitchen", "Crispy masala dosa recipe with potato filling."],
  ["0XsNCe0nd_0", "4 must try crispy dosa recipes for morning breakfast | easy & tasty dosa recipes | healthy dosa", "Hebbars Kitchen", "Crispy dosa recipes for breakfast, including instant and rava dosa."],
  ["uT5Y38EcXJ8", "2 instant crispy dosa recipe - aloo dosa, besan dosa & red chutney | instant south indian breakfast", "Hebbars Kitchen", "Two instant crispy dosa recipes with potato or gram flour."]
];

const catalog = COLLECTION.map(([id, title, source, snippet], index) => Object.freeze({
  topic: index < 3 ? "tap" : "dosa",
  title, source, snippet, url: `https://www.youtube.com/watch?v=${id}`,
  thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
}));

function videoMatches(value) {
  const words = unicodeWords(value);
  const aliases = { faucets: "tap", faucet: "tap", taps: "tap", dripping: "leak", drips: "leak", leaks: "leak", leaky: "leak", leaking: "leak",
    dosai: "dosa", dosas: "dosa", dose: "dosa", "डोसा": "dosa", "ದೋಸೆ": "dosa", "தோசை": "dosa", crisp: "crispy", crispier: "crispy" };
  const normalize = list => list.map(word => Object.hasOwn(aliases, word) ? aliases[word] : word);
  const query = normalize(words);
  const group = query.includes("dosa") ? "dosa" : query.includes("tap") && query.includes("leak") ? "tap" : "";
  if (!group) return [];
  const generic = new Set((group === "tap"
    ? "how to do i fix repair repairing fixing replacement replace change stop the a my of for leaking leak tap diy video videos watch guide tutorial in"
    : "how to do i make making prepare cook the a my of for video videos watch guide tutorial recipe recipes dosa in at home बनाना रेसिपी").split(" "));
  const qualifiers = query.filter(word => !generic.has(word));
  return catalog.filter(item => {
    if (item.topic !== group) return false;
    const words = new Set(normalize(unicodeWords(`${item.title} ${item.snippet}`)));
    return qualifiers.every(term => words.has(term));
  });
}

module.exports = { videoMatches };
