from SpotipyFree import Spotify
from urllib.parse import urlparse
import json
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Pasa un enlace de playlist entre comillas")

url = urlparse(sys.argv[1].strip())

if (
    url.scheme != "https"
    or url.hostname != "open.spotify.com"
    or url.username
    or url.password
):
    raise SystemExit("El enlace debe ser de open.spotify.com")

match = re.fullmatch(
    r"/(?:intl-[a-zA-Z-]+/)?playlist/([A-Za-z0-9]{22})/?",
    url.path,
)

if not match:
    raise SystemExit("El enlace debe apuntar a una playlist de spotify")

playlist_id = match.group(1)

print("Consultando la playlist...", file=sys.stderr, flush=True)

try:
    spotify = Spotify()
    result = spotify.playlist_items(playlist_id)

    if not isinstance(result, dict):
        raise ValueError("La biblioteca devolvio un formato inesperado.")

    items = result.get("items")

    if not isinstance(items, list):
        raise ValueError("La respuesta no contiene una lista de canciones.")

    tracks = []
    omitted = 0

    for item in items:
        track = item.get("track") if isinstance(item, dict) else None

        if not isinstance(track, dict):
            omitted += 1
            continue

        title = track.get("name")
        raw_artists = track.get("artists")

        if not isinstance(raw_artists, list):
            raw_artists = []

        artists = [
            artist["name"].strip()
            for artist in raw_artists
            if isinstance(artist, dict)
            and isinstance(artist.get("name"), str)
            and artist["name"].strip()
        ]

        if not isinstance(title, str) or not title.strip() or not artists:
            omitted += 1
            continue

        tracks.append({
            "title": title.strip(),
            "artists": artists,
        })

    print(json.dumps({
        "tracks": tracks,
        "received": len(items),
        "omitted": omitted,
    }, ensure_ascii=True))

except Exception as error:
    print(f"Error: {type(error).__name__}: {error}", file=sys.stderr)
    raise SystemExit(1)