# Venue API v2: data-source notes

## Public data source and operating limits

OpenStreetMap venue records can be retrieved through the Overpass API using bounded nearby-feature queries. The Overpass QL `around` filter takes a radius in metres and a latitude/longitude pair; ways and relations can return a representative `center` coordinate. This supports a coordinate-first venue API without adding a paid provider. [1] [2]

The public Overpass instances are shared resources. Their official guidance says they are not intended as the backend for an app serving more than OSM mappers; it gives a rough guideline of at most about 10,000 requests per day and below 1 GB daily transfer, and recommends running an own instance if expected usage exceeds these limits. The API therefore needs a bounded cache, request/result limits, timeouts, concurrency control, and a configurable Overpass endpoint. Higher-volume production use should configure a self-hosted or otherwise authorized provider rather than assume the public endpoint is an unlimited hosted API. [1]

## Attribution and license

OpenStreetMap data is licensed under the Open Data Commons Open Database License (ODbL). OSMF requires a visible credit to OpenStreetMap and its contributors and a clear indication that data is available under ODbL. API responses and the user-facing test fixture should include attribution metadata and a link to the OSM copyright page. [3]

## References

[1]: https://dev.overpass-api.de/overpass-doc/en/preface/commons.html "Overpass API Commons and quotas"
[2]: https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL "Overpass QL reference"
[3]: https://www.openstreetmap.org/copyright "OpenStreetMap copyright and license"