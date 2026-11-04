// Verbatim copies from the SillyTavern Dupe Link Skip extension (index.js) for the parity tests.
function normalizeSource(input) {
    const raw = String(input ?? '').trim();
    if (!raw) return '';

    if (!isValidUrl(raw)) {
        // Bare IDs, mirroring the server's /importUUID routing
        if (raw.includes('~')) return `perchance:${raw.split('~')[1].toLowerCase()}`;
        if (raw.startsWith('AICC/')) return `aicc:${raw.split('/').slice(1, 3).join('/').toLowerCase()}`;
        const uuid = raw.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
        if (uuid) return `uuid:${uuid[0].toLowerCase()}`;
        return chubKey(raw.split('/'));
    }

    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const parts = url.pathname.split('/').filter(Boolean);

    if (host.includes('chub.ai') || host.includes('characterhub.org')) {
        return chubKey(parts);
    }
    if (host.includes('perchance.org')) {
        const slug = raw.split('~')[1];
        return slug ? `perchance:${slug.toLowerCase()}` : '';
    }
    if (host.includes('realm.risuai.net')) {
        return parts[1] ? `risu:${parts[1].toLowerCase()}` : '';
    }
    if (host.includes('janitorai') || host.includes('pygmalion.chat')) {
        const uuid = raw.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
        if (uuid) return `uuid:${uuid[0].toLowerCase()}`;
    }
    if (host.includes('aicharactercards.com')) {
        return `aicc:${parts.slice(-2).join('/').toLowerCase()}`;
    }

    return `url:${host}/${parts.join('/')}${url.search}`;
}

function chubKey(parts) {
    parts = parts.filter(Boolean);
    const first = parts[0]?.toLowerCase();
    if (first === 'lorebooks') return `chublore:${parts.slice(1).join('/').toLowerCase()}`;
    if (first === 'characters') parts = parts.slice(1);
    return parts.length >= 2 ? `chub:${parts.slice(0, 2).join('/').toLowerCase()}` : '';
}

const CONTENT_FIELDS = [
    'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
    'system_prompt', 'post_history_instructions',
];

function cleanText(value) {
    return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
}

function contentHash(card) {
    if (!card) return '';
    // Saved before this extension edited the card (local image links), so it keeps matching the original
    const saved = (card.data?.extensions ?? card.extensions)?.dupe_link_skip?.content_hash;
    if (saved) return saved;
    const get = (field) => card.data?.[field] ?? card[field];

    const fields = CONTENT_FIELDS.map(f => cleanText(get(f)));
    const greetings = (get('alternate_greetings') ?? []).map(cleanText).filter(Boolean);
    const book = (get('character_book')?.entries ?? []).map(e => [
        (e.keys ?? []).map(cleanText).join(','),
        (e.secondary_keys ?? []).map(cleanText).join(','),
        cleanText(e.content),
    ]);

    // Name alone isn't enough to call two cards identical
    if (!fields.slice(1).some(Boolean) && !greetings.length) return '';

    const text = JSON.stringify([fields, greetings, book]);
    return `${getStringHash(text, 0).toString(36)}.${getStringHash(text, 1).toString(36)}`;
}
