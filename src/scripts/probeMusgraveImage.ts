/**
 * Does a Musgrave product image URL actually load?
 *
 * The API returns the image as a PATH, so a host has to be chosen for it. That
 * choice was a guess: the storefront (`www.`) rather than the API host
 * (`www-api.`). This checks which one — if either — actually serves the file,
 * and whether it needs the logged-in session.
 *
 * Read-only.
 *
 * Usage: npx tsx src/scripts/probeMusgraveImage.ts [query]
 */

import 'dotenv/config';
import axios from 'axios';

import { searchMusgrave } from '../services/musgrave.service.js';

const query = process.argv[2] ?? 'coke';

const hits = await searchMusgrave(query);
const withImage = hits.find((hit) => hit.card.imageUrl);

if (!withImage?.card.imageUrl) {
  console.log('No hit carried an image URL at all.');
  process.exit(1);
}

const resolved = withImage.card.imageUrl;
console.log(`\nProduct : ${withImage.card.name}`);
console.log(`Resolved: ${resolved}`);

// The path, independent of whichever host was chosen upstream.
const path = new URL(resolved).pathname;

const candidates = [
  `https://www.musgravemarketplace.ie${path}`,
  `https://www-api.musgravemarketplace.ie${path}`,
];

for (const url of candidates) {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      validateStatus: () => true,
      maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    const type = String(response.headers['content-type'] ?? '');
    const bytes = (response.data as ArrayBuffer).byteLength;
    const isImage = response.status === 200 && type.startsWith('image/');

    console.log(
      `\n${isImage ? 'OK  ' : 'BAD '} ${url}\n     ` +
        `status=${response.status} type=${type || '(none)'} bytes=${bytes}`,
    );
  } catch (error) {
    console.log(
      `\nERR  ${url}\n     ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
