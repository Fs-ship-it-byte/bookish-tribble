const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

const PS_UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };

// ==========================================
// UTILIDADES Y FUNCIONES PURAS
// ==========================================

const EMBED_HOSTS = [
    'streamwish', 'niramirus', 'filemoon', 'embedwish', 'vidhide',
    'vidhideplus', 'wishfast', 'strwish', 'awish', 'flaswish',
    'swdyu', 'embedrise', 'kerapoxy', 'smoothpre', 'fsdcmo',
    'loadpre', 'doodstream', 'voe.sx', 'moon.watch',
    'vidmoly', 'vudeo', 'mp4upload', 'vtube.to', 'upstream',
    'hgplaycdn', 'medixiru'
];

function patchDtoE(url) {
    return url.replace(/\/d\/([A-Za-z0-9]+)(\?|$|#)/, '/e/$1$2').replace(/\/d\/([A-Za-z0-9]+)$/, '/e/$1');
}

function isEmbedHost(url) {
    for (var i = 0; i < EMBED_HOSTS.length; i++) {
        if (url.indexOf(EMBED_HOSTS[i]) !== -1) return true;
    }
    return false;
}

function parseDownloadTable(html) {
    var results = [];
    var dlRe = /<tr><td><span[^>]*>[^<]*<\/span>\s*([^<]+?)\s*<\/td><td>([^<]+)<\/td><td>[^<]*<span>([^<]+)<\/span>[^<]*<\/td><td><a[^>]+href="(https?:\/\/player\.poseidonhd2\.co\/download\.php[^"]+)"/gi;
    var langMap = { 'latino': 'Latino', 'español': 'Español', 'castellano': 'Español', 'subtitulado': 'Subtitulado', 'english': 'Subtitulado' };
    var m;
    while ((m = dlRe.exec(html)) !== null) {
        var serverRaw = m[1].replace(/^\s+|\s+$/g, '').toLowerCase();
        if (serverRaw !== 'streamwish') continue;
        var langRaw = m[2].replace(/^\s+|\s+$/g, '').toLowerCase();
        var lang = langMap[langRaw] || m[2].replace(/^\s+|\s+$/g, '');
        var quality = m[3].replace(/^\s+|\s+$/g, '') || 'HD';
        results.push({ playerUrl: m[4], label: 'Streamwish · ' + lang + ' · ' + quality + ' (DL)' });
    }
    return results;
}

function parseCliLiStreams(html) {
    var results = [];
    var langMap = { 'español latino': 'Latino', 'latino': 'Latino', 'español': 'Español', 'castellano': 'Español', 'subtitulado': 'Subtitulado', 'english': 'Subtitulado' };
    var groupRe = /_1R6bW_0"[^>]*>\s*<span>([^<]+)[\s\S]*?sub-tab-lang[^"]*"([\s\S]*?)<\/ul>/gi;
    var gm;
    while ((gm = groupRe.exec(html)) !== null) {
        var langRaw = gm[1].replace(/^\s+|\s+$/g, '').toLowerCase();
        var lang = langMap[langRaw] || (langRaw ? (langRaw.charAt(0).toUpperCase() + langRaw.slice(1)) : 'Latino');
        var block = gm[2];
        var cliliRe = /data-tr="([^"]+)"[^>]*>[\s\S]*?<span[^>]*>\s*([^<]+)\s*<\/span>/gi;
        var cm;
        while ((cm = cliliRe.exec(block)) !== null) {
            var playerUrl = cm[1];
            var text = cm[2].replace(/^\s+|\s+$/g, '');
            var serverMatch = text.match(/^\d+\.\s*([^\s-]+)/i);
            if (!serverMatch) continue;
            var serverName = serverMatch[1].toLowerCase();
            if (serverName !== 'vidhide' && serverName !== 'vidhideplus') continue;
            var qualMatch = text.match(/-\s*(\S+)\s*$/i);
            var quality = qualMatch ? qualMatch[1] : 'HD';
            var displayName = serverName === 'vidhideplus' ? 'VidHidePlus' : 'VidHide';
            results.push({ playerUrl: playerUrl, label: displayName + ' · ' + lang + ' · ' + quality });
        }
    }
    return results;
}

function normPsTitle(s) {
    return s.toLowerCase().replace(/[áàäâ]/g, 'a').replace(/[éèëê]/g, 'e').replace(/[íìïî]/g, 'i').replace(/[óòöô]/g, 'o').replace(/[úùüû]/g, 'u').replace(/ñ/g, 'n').replace(/[^a-z0-9 ]/g, ' ').replace(/ +/g, ' ').replace(/^ | $/g, '');
}

var PS_STOP = { 'de':1,'la':1,'el':1,'los':1,'las':1,'un':1,'una':1,'en':1,'y':1,'a':1,'the':1,'of':1,'and':1,'del':1,'le':1,'les':1,'des':1,'da':1,'o':1,'e':1 };

function scorePsResult(qWords, tn) {
    if (!qWords.length) return 50;
    var tWords = tn.split(' ');
    var matched = 0;
    for (var qi = 0; qi < qWords.length; qi++) {
        var qw = qWords[qi];
        for (var ti = 0; ti < tWords.length; ti++) {
            var tw = tWords[ti];
            if (!tw) continue;
            if (qw === tw) { matched++; break; }
            if (qw.length >= 5 && tw.length >= 5) {
                var shorter = qw.length <= tw.length ? qw : tw;
                var longer = qw.length <= tw.length ? tw : qw;
                if (longer.indexOf(shorter) === 0 && shorter.length * 10 >= longer.length * 8) { matched++; break; }
            }
        }
    }
    return Math.floor(matched * 80 / qWords.length);
}

function filterPsResults(results, query) {
    var qn = normPsTitle(query);
    var qRaw = qn.split(' ');
    var qWords = [];
    for (var i = 0; i < qRaw.length; i++) {
        if (qRaw[i].length > 2 && !PS_STOP[qRaw[i]]) qWords.push(qRaw[i]);
    }
    var scored = [];
    for (var j = 0; j < results.length; j++) {
        var tn = normPsTitle(results[j].title);
        var score;
        if (qn === tn) score = 100;
        else if (tn.indexOf(qn) === 0 && (tn.length === qn.length || tn.charAt(qn.length) === ' ')) score = 90;
        else score = scorePsResult(qWords, tn);
        if (score >= 40) scored.push({ r: results[j], score: score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map(s => s.r);
}

function parseNextData(html) {
    var nm = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
    if (!nm) return null;
    try {
        let data = JSON.parse(nm[1]);
        return (data && data.props && data.props.pageProps) ? data.props.pageProps : null;
    } catch(e) { return null; }
}


// ==========================================
// FUNCIONES ASÍNCRONAS (EXTRACTORES)
// ==========================================

async function resolveEmbedUrl(poseidonUrl) {
    var html;
    try {
        html = (await axios.get(poseidonUrl, { headers: PS_UA, timeout: 8000 })).data;
    } catch(e) { return null; }

    var patterns = [
        /window\.location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i,
        /location\.replace\s*\(\s*['"]([^'"]+)['"]\s*\)/i,
        /<meta[^>]+http-equiv\s*=\s*['"]refresh['""][^>]+content\s*=\s*['"][^'">\s]+url=([^'">\s]+)/i,
        /<iframe[^>]+src\s*=\s*['"]([^'"]+)['"]/i,
        /src\s*=\s*['"]((?:https?:)?\/\/[^'"]+\/(?:e|embed|v)\/[a-zA-Z0-9]+[^'"]*)['"]/i,
        /(https?:\/\/[^\s'"<>\\]+\/(?:e|embed|v)\/[a-zA-Z0-9]+[^\s'"<>\\]*)/i
    ];

    for (var i = 0; i < patterns.length; i++) {
        var m = html.match(patterns[i]);
        if (m && m[1]) {
            let url = m[1];
            if (url.startsWith('//')) url = 'https:' + url;
            if (url.startsWith('/')) url = new URL(url, poseidonUrl).href;
            return url;
        }
    }
    return null;
}

async function resolveDirectVideoUrl(embedUrl) {
    try {
        const res = await axios.get(embedUrl, { 
            headers: { ...PS_UA, 'Referer': 'https://www.poseidonhd2.co/' }, 
            timeout: 10000 
        });
        
        let html = res.data;
        const finalUrl = res.request.res.responseUrl || embedUrl;
        const origin = new URL(finalUrl).origin;

        const evalRegex = /eval\(\s*function\s*\(p,\s*a,\s*c,\s*k,\s*e,\s*[rd]\).*?\}\('([\s\S]*?)',\s*(\d+),\s*(\d+),\s*'([\s\S]*?)'\s*\.split\('\\|'\)/g;
        let match;
        let unpackedHtml = html;
        
        while ((match = evalRegex.exec(html)) !== null) {
            let p = match[1];
            let a = parseInt(match[2], 10);
            let c = parseInt(match[3], 10);
            let k = match[4].split('|');
            let e = function(c) { return (c < a ? '' : e(Math.floor(c / a))) + ((c = c % a) > 35 ? String.fromCharCode(c + 29) : c.toString(36)); };
            while (c--) { if (k[c]) p = p.replace(new RegExp('\\b' + e(c) + '\\b', 'g'), k[c]); }
            unpackedHtml += "\n" + p;
        }

        const fileRegex = /(?:file|src|source)\s*:\s*["'](https?:\/\/[^"'\s]+\.(?:m3u8|mp4)[^"'\s]*)['"]/i;
        let linkMatch = unpackedHtml.match(fileRegex);
        
        if (!linkMatch) {
            linkMatch = unpackedHtml.match(/(https?:\/\/[^"'\s]+\.(?:m3u8|mp4)[^"'\s]*)/i);
        }

        if (linkMatch && linkMatch[1]) {
            return {
                url: linkMatch[1],
                headers: { "Referer": origin + '/', "Origin": origin, "User-Agent": PS_UA['User-Agent'] }
            };
        }
    } catch (err) {
        return null;
    }
    return null;
}

async function searchPoseidon2hd(q) {
    var html;
    try {
        html = (await axios.get('https://www.poseidonhd2.co/search?q=' + encodeURIComponent(q), { headers: PS_UA, timeout: 8000 })).data;
    } catch(e) { return []; }

    var results = [];
    var seen = {};
    var liRe = /<li[^>]+class="[^"]*TPostMv[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
    var item;
    while ((item = liRe.exec(html)) !== null) {
        var block = item[1];
        var aMatch = block.match(/<a\s[^>]*href="(\/pelicula\/[^"]+|\/serie\/[^"]+)"/i);
        if (!aMatch) continue;
        var url = 'https://www.poseidonhd2.co' + aMatch[1];
        if (seen[url]) continue;
        seen[url] = true;

        var tMatch = block.match(/<span[^>]+class="[^"]*Title[^"]*block[^"]*"[^>]*>([^<]+)<\/span>/i);
        if (!tMatch) tMatch = block.match(/<span[^>]+class="[^"]*block[^"]*Title[^"]*"[^>]*>([^<]+)<\/span>/i);
        if (!tMatch) continue;
        var title = tMatch[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
        if (!title) continue;

        results.push({ title: title, url: url });
    }
    return filterPsResults(results, q);
}

async function fetchPoseidonHD2Streams(url) {
    var html;
    try {
        html = (await axios.get(url, { headers: PS_UA, timeout: 8000 })).data;
    } catch(e) { return null; }

    var pp = parseNextData(html);
    if (!pp) return null;

    var subject = pp.thisMovie || pp.thisEpisode || null;
    if (!subject) return null;

    var videos = subject.videos || {};
    var streams = [];
    var langMap = { spanish: 'Español', latino: 'Latino', english: 'Subtitulado' };
    var langs = ['spanish', 'latino', 'english'];

    for (var li = 0; li < langs.length; li++) {
        var lang = langs[li];
        var entries = videos[lang] || [];
        for (var ei = 0; ei < entries.length; ei++) {
            var e = entries[ei];
            if (!e.result) continue;
            if (e.cyberlocker === 'streamwish' || e.cyberlocker === 'vidhide') {
                var serverName = e.cyberlocker === 'streamwish' ? 'Streamwish' : 'VidHide';
                streams.push({ playerUrl: e.result, label: `${serverName} · ${langMap[lang]} · ${e.quality || 'HD'}` });
            }
        }
    }

    streams = streams.concat(parseDownloadTable(html)).concat(parseCliLiStreams(html));
    return { streams: streams };
}

async function fetchPoseidonHD2Series(url) {
    var html;
    try {
        html = (await axios.get(url, { headers: PS_UA, timeout: 8000 })).data;
    } catch(e) { return null; }

    var pp = parseNextData(html);
    if (!pp) return null;

    var subject = pp.thisSerie || null;
    if (!subject) return null;

    var slugMatch = url.match(/\/serie\/\d+\/([^/?#]+)/);
    return {
        tmdbId: subject.TMDbId ? subject.TMDbId.toString() : null,
        slug: slugMatch ? slugMatch[1] : null
    };
}

async function fetchPoseidonHD2Episode(tmdbId, slug, season, episode) {
    var url = `https://www.poseidonhd2.co/serie/${tmdbId}/${slug}/temporada/${season}/episodio/${episode}`;
    return await fetchPoseidonHD2Streams(url);
}


// ==========================================
// INTEGRACIÓN CON STREMIO ADDON SDK
// ==========================================
const manifest = {
    id: "org.poseidonhd2.stremio",
    version: "1.0.0",
    name: "PoseidonHD2",
    description: "Películas y Series en Español/Latino obtenidas de PoseidonHD",
    catalogs: [],
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"] 
};

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async (args) => {
    const [imdbId, season, episode] = args.id.split(':');
    
    let titleToSearch = '';
    try {
        const metaRes = await axios.get(`https://v3-cinemeta.strem.io/meta/${args.type}/${imdbId}.json`);
        if (metaRes.data && metaRes.data.meta) {
            titleToSearch = metaRes.data.meta.name;
        }
    } catch (e) {
        console.log("No se pudo obtener meta de cinemeta para", imdbId);
        return { streams: [] };
    }

    if (!titleToSearch) return { streams: [] };

    const searchResults = await searchPoseidon2hd(titleToSearch);
    if (!searchResults || searchResults.length === 0) return { streams: [] };
    
    const target = searchResults[0]; 
    let poseidonData = null;

    if (args.type === 'movie') {
        poseidonData = await fetchPoseidonHD2Streams(target.url);
    } else if (args.type === 'series') {
        const seriesData = await fetchPoseidonHD2Series(target.url);
        if (seriesData && seriesData.tmdbId && seriesData.slug) {
            poseidonData = await fetchPoseidonHD2Episode(seriesData.tmdbId, seriesData.slug, season, episode);
        }
    }

    if (!poseidonData || !poseidonData.streams) return { streams: [] };

    const stremioStreams = await Promise.all(poseidonData.streams.map(async (s) => {
        let cleanLabel = s.label.replace(' (DL)', '');
        
        const embedUrl = await resolveEmbedUrl(s.playerUrl);
        if (embedUrl) {
            const directData = await resolveDirectVideoUrl(embedUrl);
            
            if (directData && directData.url) {
                return {
                    name: "PoseidonHD",
                    description: cleanLabel + "\n(Directo)",
                    url: directData.url,
                    behaviorHints: {
                        notWebReady: true,
                        proxyHeaders: {
                            request: directData.headers
                        }
                    }
                };
            }
            
            return {
                name: "PoseidonHD",
                description: cleanLabel + "\n(External Web)",
                externalUrl: embedUrl
            };
        }

        return null;
    }));

    return { streams: stremioStreams.filter(stream => stream !== null) };
});

const port = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: port });
console.log(`Addon de Stremio escuchando en puerto ${port}`);
