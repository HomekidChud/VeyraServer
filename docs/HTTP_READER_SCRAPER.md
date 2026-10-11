# HTTP Reader and Scraper

Veyra's HTTP reader provides a lightweight fallback for pages that need JavaScript when the Render service has Chromium disabled. It fetches public content over HTTP, extracts text and links, and serves the result in a minimal dark-themed reader. It does not execute page scripts or require a browser runtime.

## JSON scraper

Request a public HTTP(S) page:

```sh
curl --get 'https://veyraserver-xscy.onrender.com/api/scrape' \
  --data-urlencode 'url=https://example.com/article'
```

A successful response includes the final URL, page title and description, extracted text, headings, safe links, feed links, an extraction status, and bounded fetch metadata. The service returns only text-oriented page data; it does not return the upstream HTML or run JavaScript found in it.

The reader iframe uses the same extractor:

```text
https://veyraserver-xscy.onrender.com/api/reader?url=https%3A%2F%2Fexample.com%2Farticle&sid=<veyra-session-id>
```

The optional `sid` lets links in the reader navigate through the existing Veyra tab. The route returns an isolated HTML page with an allowlisted CSP, scripts disabled except for a nonce-protected link-navigation bridge, and no third-party scripts or page resources.

## YouTube

For a public YouTube watch URL, Veyra checks official oEmbed metadata and uses the official `youtube-nocookie.com` player embed when the video permits embedding. This path needs no server-side Chromium.

YouTube's home, search, and many channel pages are JavaScript applications. The HTTP reader can list videos only when the fetched public HTML includes parsable `ytInitialData`; it cannot create YouTube's interactive application or promise that every feed is present. If the upstream returns a consent page, sign-in wall, or anti-bot challenge, Veyra displays that limitation rather than trying to bypass it.

## Safety and limits

- Only HTTP(S) URLs are accepted. URLs with credentials or sensitive query parameters are rejected.
- Public-address checks apply before retrieval and after redirects. The acquisition manager enforces robots.txt, request timeouts, redirect limits, and host/global concurrency limits.
- The reader caps the upstream response at 4 MiB, extracted text at 80,000 characters, and displayed links at 100. The page parser may return fewer entries.
- HTML, XHTML, plain text, JSON, and XML text documents are supported. Binary files are not.
- `robots.txt` denials, private-address targets, unsupported content types, oversized responses, consent pages, and security challenges are surfaced explicitly.
- This is a static HTTP reader, not a general browser. Pages that require JavaScript, authentication, user interaction, or browser-only APIs may remain incomplete.
- No new environment variable or API key is required.
