"use strict";

const { Parser } = require("htmlparser2");
const { languageTag } = require("./search-language");

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const localName = name => name.split(":").at(-1).toLowerCase();
const hasRel = (value, name) => String(value || "").toLowerCase().split(/\s+/).includes(name);

// Walk only direct sitemap entries. Do not treat media extension <loc> values
// as pages, infer sitemap indexes from filenames, or resolve XML entities.
function walkSitemap(xml, visit, maxEntries) {
  let depth = 0, root = "", locDepth = 0, loc = "", emitted = 0;
  let namespace = "", rootAttributes = {};
  let entryAttributes = {};
  let insideEntry = false;
  const parser = new Parser({
    onopentag(name, attributes) {
      depth++;
      const tag = localName(name);
      if (depth === 1) {
        root = tag;
        namespace = name.includes(":") ? name.split(":")[0] : "";
        rootAttributes = attributes;
        return;
      }
      if (depth === 2) {
        insideEntry = (root === "urlset" && tag === "url") || (root === "sitemapindex" && tag === "sitemap");
        entryAttributes = attributes;
      }
      if (depth !== 3 || !insideEntry) return;
      if (tag === "loc" && (!name.includes(":") || name.split(":")[0] === namespace)) {
        locDepth = depth;
        loc = "";
      } else if (root === "urlset" && tag === "link" && name.includes(":")) {
        const key = `xmlns:${name.split(":")[0]}`;
        const declared = attributes[key] ?? entryAttributes[key] ?? rootAttributes[key];
        if (declared === XHTML_NS && hasRel(attributes.rel, "alternate") && languageTag(attributes.hreflang)) {
          emit(attributes.href, "locale-alternate");
        }
      }
    },
    ontext(text) {
      if (locDepth && depth === locDepth && loc.length <= 4096) loc += text.slice(0, 4097);
    },
    onclosetag() {
      if (locDepth === depth) {
        emit(loc.trim(), root === "sitemapindex" ? "sitemap-index" : "sitemap");
        locDepth = 0;
      }
      if (depth === 2) insideEntry = false;
      depth--;
    }
  }, { xmlMode: true, decodeEntities: true });
  function emit(url, kind) {
    if (typeof url !== "string" || !url || url.length > 4096 || emitted >= maxEntries) return;
    if (++emitted >= maxEntries) parser.pause();
    visit(url, kind);
  }
  // The response byte limit is enforced upstream.
  parser.end(xml);
}

module.exports = { walkSitemap, hasRel };
