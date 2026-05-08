import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import https from 'https';
import http from 'http';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const openclawHome = path.resolve(__dirname, '..', '..');

// ─── Paths ────────────────────────────────────────────────────────────────────
const DATA_DIR     = path.join(__dirname, 'data');
const RESULTS_DIR  = path.join(DATA_DIR, 'results');
const RAW_DIR      = path.join(DATA_DIR, 'raw');
const CONTENT_DIR  = path.join(DATA_DIR, 'content');
const STATE_FILE   = path.join(DATA_DIR, 'state.json');
const BLACK_FILE   = path.join(DATA_DIR, 'blacklist_uid.json');
const CONFIG_FILE  = path.join(__dirname, 'config.json');

for (const d of [DATA_DIR, RESULTS_DIR, RAW_DIR, CONTENT_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function readJson(file, def = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function downloadImage(url, dest) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to download image: ${res.statusCode}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(dest);
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

function loadConfig()    { return readJson(CONFIG_FILE, { adminIds: [], profiles: {} }); }
function saveConfig(cfg) { writeJson(CONFIG_FILE, cfg); }
function loadState(profile)     { return readJson(path.join(DATA_DIR, `state_${profile}.json`), { lastRun: null, scanned: [], authorPostCount: {} }); }
function saveState(profile, s)    { writeJson(path.join(DATA_DIR, `state_${profile}.json`), s); }
function loadBlacklist(profile) { return readJson(path.join(DATA_DIR, `blacklist_${profile}.json`), { uids: [] }); }
function saveBlacklist(profile, b){ writeJson(path.join(DATA_DIR, `blacklist_${profile}.json`), b); }

function todayKey() { return new Date().toISOString().slice(0, 10); }
function resultsFile(profile) { return path.join(RESULTS_DIR, `${profile}_${todayKey()}.json`); }
function appendResult(profile, item) {
  const file = resultsFile(profile);
  const list = readJson(file, []);
  list.push(item);
  writeJson(file, list);
}

// ─── sendMsg utility ──────────────────────────────────────────────────────────
async function sendMsg(ctx, convId, isGroup, text) {
  const paths = [
    pathToFileURL(path.join(openclawHome, 'npm/node_modules/@openclaw/zalouser/dist/test-api.js')).href,
    'file:///usr/local/lib/node_modules/openclaw/dist/extensions/zalouser/test-api.js',
    'openclaw/dist/extensions/zalouser/test-api.js'
  ];
  let send;
  for (const p of paths) {
    try { const m = await import(p); if (m?.sendMessageZalouser) { send = m.sendMessageZalouser; break; } } catch {}
  }
  if (!send) { console.error('[fb-crawler] sendMsg: API not found'); return; }
  const tid = String(convId).replace(/^group:/, '');
  await send(tid, String(text), { isGroup, profile: ctx?.accountId || 'default', textMode: 'markdown' });
}

// ─── Time helper: detect if a post time string is older than current month ─────
function isOlderThanCurrentMonth(timeStr) {
  if (!timeStr) return false;
  const t = timeStr.toLowerCase().trim();
  // "X tuần" — 5+ weeks = safely last month
  const weekMatch = t.match(/(\d+)\s*tu[ầâ]n/);
  if (weekMatch && parseInt(weekMatch[1]) >= 5) return true;
  // "DD Tháng M" — explicit month
  const dateMatch = t.match(/(\d+)\s*th[áa]ng\s*(\d+)/);
  if (dateMatch) {
    const postMonth = parseInt(dateMatch[2]);
    const nowMonth  = new Date().getMonth() + 1;
    const nowYear   = new Date().getFullYear();
    // Simple: if postMonth < nowMonth (same year context) it's older
    if (postMonth < nowMonth) return true;
  }
  return false;
}

// ─── Raw store helpers ────────────────────────────────────────────────────────
function rawFile(profile, groupKey) {
  const ym = new Date().toISOString().slice(0, 7); // YYYY-MM
  return path.join(RAW_DIR, `${profile}_${groupKey}-${ym}.json`);
}
function loadRaw(profile, groupKey) { return readJson(rawFile(profile, groupKey), []); }
function saveRaw(profile, groupKey, posts) { writeJson(rawFile(profile, groupKey), posts); }

// ─── Dynamic Rules Evaluator ──────────────────────────────────────────────────
function textContainsAny(text, keywords) {
  if (!keywords || keywords.length === 0) return false;
  const t = text.toLowerCase();
  return keywords.some(k => t.includes(k.toLowerCase()));
}

function detectLocation(text, locationsObj) {
  if (!locationsObj || Object.keys(locationsObj).length === 0) return 'Any';
  const t = text.toLowerCase();
  for (const [region, keywords] of Object.entries(locationsObj)) {
    if (keywords.some(k => t.includes(k.toLowerCase()))) return region;
  }
  return null;
}

function extractRegexFields(text, regexObj) {
  if (!regexObj) return {};
  const extracted = {};
  for (const [key, pattern] of Object.entries(regexObj)) {
    try {
      const re = new RegExp(pattern, 'gi');
      const matches = text.match(re);
      extracted[key] = matches ? [...new Set(matches)].join(', ') : '';
    } catch(e) {
      extracted[key] = '';
    }
  }
  return extracted;
}

// ─── AI Classifier ────────────────────────────────────────────────────────────
async function analyzePostAI(text) {
  try {
    const res = await fetch('http://9router:20128/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer sk-no-key' },
      body: JSON.stringify({
        model: 'smart-route',
        messages: [
          {
            role: 'system',
            content: `Bạn là AI kiểm duyệt bài đăng bán xe máy. Nhiệm vụ của bạn là đọc bài viết và xác định đây có phải bài "Cá nhân đăng bán thanh lý xe máy" HỢP LỆ không.
HỢP LỆ (trả về YES):
- Cá nhân rao bán chiếc xe máy nguyên chiếc của họ (thanh lý, pass lại, kẹt tiền bán...).

KHÔNG HỢP LỆ (trả về NO):
- Bài bán mắt kính, bất động sản, quần áo, dịch vụ hớt tóc, v.v.
- Hỏi đáp, thảo luận, khoe xe (ví dụ: "thay phuộc loại nào", "xe đẹp quá").
- Mua bán phụ tùng, đồ chơi xe (mâm, lốp, phuộc, chuông nồi...).
- Bài đăng tìm mua xe.
- Cửa hàng (salon) chuyên nghiệp bán nhiều xe, hỗ trợ trả góp, bao nợ xấu.

LƯU Ý: Nếu nghi ngờ, hãy ưu tiên trả về NO. CHỈ TRẢ LỜI ĐÚNG 1 TỪ: "YES" hoặc "NO".`
          },
          {
            role: 'user',
            content: 'Bài viết:\n' + text.substring(0, 1500)
          }
        ],
        temperature: 0.1,
        stream: false
      }),
      signal: AbortSignal.timeout(120000)
    });
    if (!res.ok) {
      console.error('[fb-crawler] AI HTTP Error:', res.status);
      return false; // Fail closed: reject if AI fails
    }
    
    const resText = await res.text();
    let data;
    try {
      data = JSON.parse(resText);
    } catch (e) {
      // If the proxy forces SSE (data: {...})
      const lines = resText.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]'));
      if (lines.length > 0) {
        // Just grab the first chunk's content or aggregate
        let aggregated = '';
        for (const line of lines) {
           try {
             const chunk = JSON.parse(line.substring(6));
             aggregated += chunk.choices?.[0]?.delta?.content || chunk.choices?.[0]?.message?.content || '';
           } catch(err) {}
        }
        return aggregated.toUpperCase().includes('YES');
      }
      throw new Error('Unparseable response: ' + resText.substring(0, 50));
    }

    const resultText = data.choices?.[0]?.message?.content?.trim().toUpperCase() || 'NO';
    return resultText.includes('YES');
  } catch (err) {
    console.error('[fb-crawler] AI Network error:', err.message);
    return false; // Fail closed
  }
}


// ─── Core crawl logic ─────────────────────────────────────────────────────────
async function runCrawlSession(sessionId, groupSlice, sendReport, api, groupsOverride = null, profile = 'banxe') {
  const allCfg = loadConfig();
  const cfg   = allCfg.profiles?.[profile] || { rules: {}, groups: [] };
  const state = loadState(profile);
  const bl    = loadBlacklist(profile);

  const rules = cfg.rules || {};
  const requireKeywords = rules.requireKeywords || [];
  const blockKeywords = rules.blockKeywords || [];
  const locationsObj = rules.locations || {};
  const extractRegexObj = rules.extractRegex || {};

  const groups = groupsOverride || (groupSlice ? (cfg.groups || []).slice(groupSlice[0], groupSlice[1]) : (cfg.groups || []));
  if (groups.length === 0) {
    console.log(`[fb-crawler] Session ${sessionId} (${profile}): No groups to scan in this slice.`);
    return;
  }
  const scannedSet = new Set(state.scanned || []);

  // scrollDepth: when lastRun is set, scroll based on gap; first-run scans deep to cover full month
  let maxScroll = 10;
  if (state.lastRun) {
    const diffMin = (Date.now() - new Date(state.lastRun).getTime()) / 60000;
    if (diffMin < 30) maxScroll = 2;
    else if (diffMin < 240) maxScroll = 4;
    else if (diffMin < 720) maxScroll = 6;
    else maxScroll = 10;
  }

  async function btExec(cmd) {
    try {
      const { stdout } = await execAsync(`node /root/project/.openclaw/workspace-bot/browser-tool.js ${cmd}`);
      return stdout || '';
    } catch(e) {
      console.error('[fb-crawler] btExec err:', e.message);
      return '';
    }
  }

  let foundTotal = 0, skippedPro = 0, skippedLoc = 0;
  const foundItems = [];

  for (const group of groups) {
    try {
      console.log(`[fb-crawler] Session ${sessionId} (${profile}) → ${group.name}`);

      await btExec(`open "${group.url}"`);
      await btExec('wait 4000');

      // ── PHASE 1: Collect raw posts until previous month ──────────────────
      const existingRaw = loadRaw(profile, group.key);
      const existingRawSet = new Set(existingRaw.map(p => p.permalink));
      let allPagePosts = [];
      let reachedOldPosts = false;
      for (let scroll = 0; scroll <= maxScroll && !reachedOldPosts; scroll++) {
        // Close login popups if any
        await btExec('evaluate "document.querySelectorAll(\'div[aria-label=\\\'Đóng\\\'], div[aria-label=\\\'Close\\\']\').forEach(b => b.click())"');
        await btExec('evaluate "document.querySelectorAll(\'div[role=button]\').forEach(b => { if(b?.innerText?.includes(\'Xem thêm\')) b.click() })"');
        await btExec('wait 1200');
        const out = await btExec('get_posts');
        if (out.includes('Chrome Debug not running') || out.includes('socket hang up') || out.includes('Connection refused')) {
          console.log('[fb-crawler] Chrome connection error detected!');
          throw new Error('Không kết nối được với Chrome! Hãy đảm bảo bạn đã mở Chrome với cờ --remote-debugging-port=9222.');
        }
        try {
          const match = out.match(/\[[\s\S]*\]/);
          if (match) {
            const parsed = JSON.parse(match[0]);
            allPagePosts.push(...parsed);
            // Stop if ANY post in this batch is older than current month
            if (parsed.some(p => isOlderThanCurrentMonth(p.time))) {
              reachedOldPosts = true;
              console.log(`[fb-crawler] ${group.key}: reached end of current month at scroll ${scroll}`);
            }
          }
        } catch {}
        if (scroll < maxScroll && !reachedOldPosts) {
          await btExec('scroll 2500');
          await btExec('wait 2500');
        }
      }
      // ── PHASE 2: Deduplicate within page and against raw store ───────────
      const seenOnPage = new Set();
      // Cải tiến: Tránh trùng lặp do Facebook đổi định dạng URL (/posts/ vs /permalink/) hoặc trùng content
      const existingTextHashes = new Set(existingRaw.map(p => (p.text || '').substring(0, 100).replace(/\s+/g, '').toLowerCase()));
      
      const newRawPosts = [];
      for (const p of allPagePosts) {
        if (!p.permalink || seenOnPage.has(p.permalink)) continue;
        
        const textHash = (p.text || '').substring(0, 100).replace(/\s+/g, '').toLowerCase();
        
        // Extract post ID from permalink to catch /posts/123 vs /permalink/123
        const idMatch = p.permalink.match(/(?:posts|permalink|story_fbid=|photos|videos|reel)\/?=?(\d+)/);
        const postId = idMatch ? idMatch[1] : p.permalink;
        
        // Check if already in raw based on exact link, post ID string, or text content similarity
        const isDuplicateLink = existingRawSet.has(p.permalink);
        const isDuplicateId = existingRaw.some(r => r.permalink.includes(postId) && postId.length > 5);
        const isDuplicateText = existingTextHashes.has(textHash) && textHash.length > 20;

        if (!isDuplicateLink && !isDuplicateId && !isDuplicateText) {
          seenOnPage.add(p.permalink);
          existingTextHashes.add(textHash);
          
          const newEntry = { permalink: p.permalink, text: p.text, author: p.author, authorUrl: p.authorUrl, time: p.time, images: p.images || [], scannedAt: new Date().toISOString() };
          newRawPosts.push(newEntry);
          existingRaw.push(newEntry);
        }
      }
      saveRaw(profile, group.key, existingRaw);
      console.log(`[fb-crawler] ${group.key}: ${newRawPosts.length} new raw posts (${existingRaw.length} total in store)`);
      let rawPosts = allPagePosts; // keep for compatibility

      // ── PHASE 3: Filter only NEW posts (not in global scannedSet) ─────────
      let uniquePosts = newRawPosts.map(r => ({
        text: r.text, permalink: r.permalink, author: r.author,
        authorUrl: r.authorUrl, time: r.time, images: r.images
      }));
      
      const maxLimit = rules.maxPosts;
      if (maxLimit && maxLimit > 0) {
        uniquePosts = uniquePosts.slice(0, maxLimit);
      }

      for (const post of uniquePosts) {
        const text = post.text || '';
        const link = post.permalink || '';
        const author = post.authorUrl || post.author || '';

        scannedSet.add(link);

        if (author && bl.uids.includes(author)) continue;

        // Vehicle keyword check for mixed groups
        const vehicleKws = group.vehicleKeywords || [];
        if (vehicleKws.length > 0 && !textContainsAny(text, vehicleKws)) {
          continue; // Post doesn't mention any of the target vehicle models
        }

        // For banxe profile, use AI to classify instead of strict keywords
        if (profile === 'banxe') {
          // Block check (still useful for hard blocks like "cửa hàng", "salon", "trả góp")
          if (blockKeywords.length > 0 && textContainsAny(text, blockKeywords)) {
            skippedPro++;
            if (author) { bl.uids.push(author); saveBlacklist(profile, bl); }
            continue;
          }

          // Use AI to read and classify
          const isPersonalSale = await analyzePostAI(text);
          if (!isPersonalSale) {
            skippedPro++;
            continue;
          }
        } else {
          // For other profiles (matkinh), keep keyword logic
          // Requirement check
          if (requireKeywords.length > 0 && !textContainsAny(text, requireKeywords)) {
            continue;
          }

          // Block check
          if (blockKeywords.length > 0 && textContainsAny(text, blockKeywords)) {
            skippedPro++;
            if (author) { bl.uids.push(author); saveBlacklist(profile, bl); }
            continue;
          }
        }

        // Location check
        let location = 'Any';
        if (Object.keys(locationsObj).length > 0) {
          location = detectLocation(text, locationsObj);

          if (!location && link && link !== 'N/A') {
            await btExec(`open "${link}"`);
            await btExec('wait 3000');
            const pageText = await btExec('get_text 5000');
            location = detectLocation(pageText, locationsObj);

            if (!location && author && author.startsWith('http')) {
              await btExec(`open "${author}"`);
              await btExec('wait 3000');
              const profileText = await btExec('get_text 3000');
              location = detectLocation(profileText, locationsObj);
            }
          }

          if (!location) { skippedLoc++; continue; }
        }

        const extractedData = extractRegexFields(text, extractRegexObj);
        
        const item = {
          name: group.name,
          text: text.slice(0, 300),
          extracted: extractedData,
          uid: author,
          location,
          permalink: link,
          time: post.time || '',
          groupKey: group.key,
          scannedAt: new Date().toISOString(),
        };

        // Download images and save to MD
        try {
          const dateStr = todayKey();
          const groupFolder = `${dateStr}-${group.key}`;
          const safeLink = (link && link !== 'N/A') ? link.split('?')[0] : `post_${Math.random().toString(36).substring(2,10)}`;
          const postFolder = path.basename(safeLink) || safeLink.split('/').filter(Boolean).pop() || `post_${Date.now()}`;
          const outDir = path.join(CONTENT_DIR, groupFolder, postFolder);
          
          fs.mkdirSync(outDir, { recursive: true });
          
          // Save MD
          fs.writeFileSync(path.join(outDir, `${postFolder}.md`), post.text);
          
          // Save Images
          if (post.images && post.images.length > 0) {
             post.images.forEach((imgUrl, idx) => {
                downloadImage(imgUrl, path.join(outDir, `img_${idx+1}.jpg`)).catch(e => console.log('[fb-crawler] image download failed:', e.message));
             });
          }
        } catch (err) {
          console.log('[fb-crawler] Failed to save post content to disk:', err.message);
        }

        appendResult(profile, item);
        foundItems.push(item);
        foundTotal++;
      }

      await btExec('wait 8000');

    } catch(err) {
      console.error(`[fb-crawler] Error on group ${group.name}:`, err.message);
    }
  }

  state.lastRun = new Date().toISOString();
  state.scanned = [...scannedSet].slice(-5000); // cap at 5000
  saveState(profile, state);

  const isLastSession = ['E', 'J', 'O', 'MANUAL'].includes(sessionId) || !String(sessionId).startsWith('S');
  let reportStr = `🔍 *Session ${sessionId} (${profile}) hoàn tất*\n✅ Tìm được: ${foundTotal} bài\n🚫 Bị block/Sai mục đích: ${skippedPro}\n📍 Sai vùng: ${skippedLoc}`;
  if (isLastSession || sessionId === 'MANUAL') {
    reportStr = buildDailyReport(foundItems) + `\n\n` + reportStr;
  }

  if (sendReport) await sendReport(reportStr);
}

function buildDailyReport(items) {
  const top = items.slice(-5).map(i => {
    let extra = '';
    for(const [k, v] of Object.entries(i.extracted || {})) {
      if(v) extra += `• ${k.toUpperCase()}: ${v}\n`;
    }
    const snippet = (i.text || '').split('\n')[0].substring(0, 100).trim();
    return `🏍️ *${i.name}*\n👤 ${i.uid || 'N/A'}\n📍 Khu vực: ${i.location}\n${extra}📝 ${snippet}...\n🔗 ${i.permalink}`;
  }).join('\n\n━━━━━━━━━━━━━━\n\n');
  return `📋 *TỔNG KẾT PHIÊN QUÉT*\n\n✅ TÌM THẤY: ${items.length} BÀI ĐĂNG BÁN THANH LÝ\n\n${top || 'Chưa có kết quả mới.'}\n\n👉 Gõ /report để xem báo cáo đầy đủ nhất.`;
}

// ─── Plugin Entry ─────────────────────────────────────────────────────────────
const plugin = definePluginEntry({
  id: 'openclaw-facebook-crawler',
  name: 'Facebook Crawler',
  description: 'Quét group Facebook tự động, bộ lọc tuỳ chỉnh, báo cáo qua Zalo.',

  register(api) {
    fs.writeFileSync(path.join(__dirname, 'data', 'api_keys.json'), JSON.stringify(Object.keys(api), null, 2));
    // ── Slash command handler ──────────────────────────────────────────────
    api.on('before_dispatch', async (event, ctx) => {
      if (ctx?.channelId !== 'zalouser') return;

      const content = String(event?.body || event?.content || '').trim();
      if (!content.startsWith('/')) return;

      const rawConvId  = String(ctx.conversationId || event.conversationId || '');
      const isGroupMsg = rawConvId.startsWith('group:');
      const senderId   = String(ctx.senderId || event.senderId || '');
      const plugCfg    = loadConfig();

      if (plugCfg.adminIds.length === 0 && senderId) {
        plugCfg.adminIds.push(senderId);
        saveConfig(plugCfg);
        await sendMsg(ctx, rawConvId, isGroupMsg,
          `👋 Bạn đã trở thành Admin của *Facebook Crawler*.\nGõ */help* để xem danh sách lệnh.`);
        return { handled: true };
      }

      const isAdmin = plugCfg.adminIds.includes(senderId) ||
        (api.config?.ownerId && api.config.ownerId === senderId);
      if (!isAdmin) return;

      const parts = content.trim().split(/\s+/);
      const cmd   = parts[0].toLowerCase();

      // Extract profile
      let profile = 'banxe';
      let cmdArgs = parts.slice(1);
      const profiles = plugCfg.profiles || {};
      const knownProfiles = Object.keys(profiles);
      if (cmdArgs.length > 0 && knownProfiles.includes(cmdArgs[0].toLowerCase())) {
         profile = cmdArgs[0].toLowerCase();
         cmdArgs = cmdArgs.slice(1);
      }
      const pCfg = profiles[profile] || { groups: [], rules: {} };

      const reply = (text) => sendMsg(ctx, rawConvId, isGroupMsg, text);

      if (cmd === '/help') {
        await reply(
          `🕷️ *Facebook Crawler — Danh sách lệnh*\n(Thêm [profile] sau lệnh để chọn đối tác, ví dụ: /scan matkinh. Mặc định: banxe)\n\n` +
          `*/scan [profile]* — Quét toàn bộ groups\n` +
          `*/scan [profile] <key|id>* — Quét 1 group\n` +
          `*/scan [profile] session <ID>* — Chạy 1 session\n` +
          `*/report [profile]* — Báo cáo kết quả hôm nay\n` +
          `*/report [profile] <YYYY-MM-DD>* — Báo cáo ngày cụ thể\n` +
          `*/blacklist [profile]* — Xem danh sách UID bị chặn\n` +
          `*/blacklist [profile] remove <uid>* — Xóa UID\n` +
          `*/reset [profile]* — Xóa lịch sử đã quét\n` +
          `*/cron [profile]* — Xem lịch cron\n` +
          `*/groups [profile]* — Xem danh sách groups\n` +
          `*/add-group [profile] <key> <tên> <url>* — Thêm group mới\n` +
          `*/remove-group [profile] <key|id>* — Xóa group\n` +
          `*/status [profile]* — Trạng thái plugin\n` +
          `*/set-notify* — Đặt chat hiện tại nhận báo cáo`
        );
        return { handled: true };
      }

      if (cmd === '/status') {
        const state = loadState(profile);
        const bl    = loadBlacklist(profile);
        const results = readJson(resultsFile(profile), []);
        await reply(
          `📊 *Trạng thái [${profile}]*\n\n` +
          `🕐 Lần cuối: ${state.lastRun ? new Date(state.lastRun).toLocaleString('vi-VN') : 'Chưa có'}\n` +
          `🔗 Đã quét: ${(state.scanned || []).length} bài\n` +
          `🚫 Blacklist: ${(bl.uids || []).length} UID\n` +
          `✅ KQ hôm nay: ${results.length} bài\n` +
          `📋 Số groups: ${(pCfg.groups || []).length}`
        );
        return { handled: true };
      }

      if (cmd === '/groups') {
        const lines = (pCfg.groups || []).map(g => `${g.id}. [${g.key}] ${g.name}`).join('\n');
        await reply(`📋 *Danh sách Groups [${profile}] (${(pCfg.groups||[]).length})*\n\n${lines}`);
        return { handled: true };
      }

      if (cmd === '/add-group') {
        const [key, ...rest] = cmdArgs;
        const url = rest.pop();
        const name = rest.join(' ');
        if (!key || !name || !url?.startsWith('http')) {
          await reply(`⚠️ Cú pháp: /add-group [profile] <key> <tên group> <url>`);
          return { handled: true };
        }
        const newId = Math.max(0, ...(pCfg.groups||[]).map(g => g.id)) + 1;
        if(!plugCfg.profiles[profile].groups) plugCfg.profiles[profile].groups = [];
        plugCfg.profiles[profile].groups.push({ id: newId, key, name, url });
        saveConfig(plugCfg);
        await reply(`✅ Đã thêm group #${newId} [${key}] vào [${profile}]: ${name}`);
        return { handled: true };
      }

      if (cmd === '/remove-group') {
        const target = cmdArgs[0];
        const before = (pCfg.groups||[]).length;
        if(plugCfg.profiles[profile].groups) {
           plugCfg.profiles[profile].groups = plugCfg.profiles[profile].groups.filter(g => g.key !== target && String(g.id) !== target);
        }
        saveConfig(plugCfg);
        await reply(before > (plugCfg.profiles[profile].groups||[]).length ? `✅ Đã xóa group [${target}] khỏi [${profile}].` : `⚠️ Không tìm thấy group [${target}].`);
        return { handled: true };
      }

      if (cmd === '/set-notify') {
        plugCfg.notifyConversationId = rawConvId;
        plugCfg.notifyIsGroup = isGroupMsg;
        saveConfig(plugCfg);
        await reply(`✅ Báo cáo tự động sẽ được gửi vào đây.`);
        return { handled: true };
      }

      if (cmd === '/reset') {
        const state = loadState(profile);
        const count = (state.scanned || []).length;
        state.scanned = [];
        state.lastRun = null;
        saveState(profile, state);
        await reply(`🔄 Đã xóa ${count} bài đã quét cho [${profile}]. Lần quét tiếp sẽ quét lại từ đầu.`);
        return { handled: true };
      }

      if (cmd === '/blacklist') {
        const bl = loadBlacklist(profile);
        if (cmdArgs[0] === 'remove' && cmdArgs[1]) {
          const before = bl.uids.length;
          bl.uids = bl.uids.filter(u => !u.includes(cmdArgs[1]));
          saveBlacklist(profile, bl);
          await reply(before > bl.uids.length ? `✅ Đã xóa UID khỏi blacklist [${profile}].` : `⚠️ Không tìm thấy UID.`);
        } else {
          const list = bl.uids.slice(-20).map((u, i) => `${i+1}. ${u}`).join('\n');
          await reply(`🚫 *Blacklist [${profile}] (${bl.uids.length} UID)*\n${list || 'Trống.'}`);
        }
        return { handled: true };
      }

      if (cmd === '/cron') {
        const crons = pCfg.cronSchedule || [];
        const lines = crons.map(s => {
          const gSlice = s.groupSlice ? (pCfg.groups||[]).slice(s.groupSlice[0], s.groupSlice[1]) : (pCfg.groups||[]);
          const gs = gSlice.map(g => g.key).join(', ');
          return `[${s.id}] ${s.cron} → ${gs}`;
        }).join('\n');
        await reply(`⏰ *Lịch Cron [${profile}] (${crons.length} sessions)*\n\`\`\`\n${lines}\n\`\`\``);
        return { handled: true };
      }

      if (cmd === '/report') {
        const dateKey = cmdArgs[0] || todayKey();
        const file = path.join(RESULTS_DIR, `${profile}_${dateKey}.json`);
        const items = readJson(file, []);
        if (!items.length) {
          await reply(`📭 Chưa có kết quả cho [${profile}] ngày ${dateKey}.`);
          return { handled: true };
        }
        const byRegion = {};
        items.forEach(i => { byRegion[i.location] = (byRegion[i.location] || 0) + 1; });
        const regionStr = Object.entries(byRegion).map(([k,v]) => `${k}: ${v}`).join(' | ');
        const top15 = items.slice(-15).map(i => {
            const firstLine = (i.text || '').split('\n')[0].substring(0, 80).trim() || i.name;
            const author = i.uid || 'N/A';
            const loc = i.location || 'Chưa rõ';
            const link = i.permalink || '';
            const time = i.time || 'N/A';
            const phone = i.extracted?.phone ? `📞 Liên hệ: ${i.extracted.phone}` : '';
            
            let priceLine = '';
            if (i.extracted?.price) priceLine = `💰 ${i.extracted.price}`;
            
            let snippet = (i.text || '').substring(0, 150).trim();
            // Xóa khoảng trắng thừa và dòng trắng liên tiếp
            snippet = snippet.replace(/\n\s*\n/g, ' ').replace(/\n/g, ' | ');
            if (snippet.length >= 145) snippet += '...';
            
            return `🏍️ *${firstLine}*\n👤 Người bán: ${author} ${priceLine}\n📍 Khu vực: ${loc} - 🕒 ${time}\n${phone ? phone + '\n' : ''}📝 ${snippet}\n🔗 Link: ${link}`;
        }).join('\n\n━━━━━━━━━━━━━━━━━\n\n');
        
        await reply(`📊 *BÁO CÁO KẾT QUẢ [${profile.toUpperCase()}]*\n🕐 Cập nhật: ${new Date().toLocaleString('vi-VN')}\n\n✅ Tổng số bài: ${items.length}\n📍 Phân bổ: ${regionStr || 'N/A'}\n\n━━━━━━━━━━━━━━━━━\n\n${top15}`);
        return { handled: true };
      }

      if (cmd === '/scan') {
        const arg1 = cmdArgs[0]?.toLowerCase();
        const notifyCfg = loadConfig();
        const reportTo = async (text) => {
          const cid = notifyCfg.notifyConversationId || rawConvId;
          const ig  = notifyCfg.notifyIsGroup ?? isGroupMsg;
          await sendMsg(ctx, cid, ig, text);
        };

        if (arg1 === 'session' && cmdArgs[1]) {
          const sid = cmdArgs[1].toUpperCase();
          const sess = (pCfg.cronSchedule || []).find(s => s.id === sid);
          if (!sess) {
            await reply(`⚠️ Session không hợp lệ cho [${profile}].`);
            return { handled: true };
          }
          await reply(`🚀 Bắt đầu session ${sid} cho [${profile}]...`);
          runCrawlSession(sid, sess.groupSlice, reportTo, api, null, profile).catch(console.error);
          return { handled: true };
        }

        if (arg1) {
          const g = (pCfg.groups||[]).find(g => g.key === arg1 || String(g.id) === arg1);
          if (!g) {
            await reply(`⚠️ Không tìm thấy group [${arg1}] trong [${profile}].`);
            return { handled: true };
          }
          await reply(`🔍 Đang quét group: ${g.name} [${profile}]...`);
          runCrawlSession('MANUAL', null, reportTo, api, [g], profile).catch(console.error);
          return { handled: true };
        }

        const groupsLen = (pCfg.groups||[]).length;
        await reply(`🚀 Bắt đầu quét toàn bộ ${groupsLen} groups cho [${profile}]... Mình sẽ báo cáo sau khi xong.`);
        (async () => {
          const numSess = Math.ceil(groupsLen / 5);
          if(numSess === 0) {
            await runCrawlSession('S1', null, reportTo, api, null, profile);
          } else {
            for (let i=0; i<numSess; i++) {
              await runCrawlSession(`S${i+1}`, [i*5, i*5+5], reportTo, api, null, profile);
            }
          }
        })().catch(console.error);
        return { handled: true };
      }

    }, { priority: 340 });

    const plugCfg = loadConfig();
    const profiles = plugCfg.profiles || {};
    let cronCount = 0;
    
    if (api.scheduleCron) {
      for (const [profileName, pCfg] of Object.entries(profiles)) {
        const crons = pCfg.cronSchedule || [];
        for (const sess of crons) {
          api.scheduleCron(sess.cron, async () => {
            const c = loadConfig();
            const cid = c.notifyConversationId;
            const ig  = c.notifyIsGroup || false;
            let reportTo = null;
            if (cid) {
               reportTo = async (text) => {
                 const paths = [
                   pathToFileURL(path.join(openclawHome, 'npm/node_modules/@openclaw/zalouser/dist/test-api.js')).href,
                   'file:///usr/local/lib/node_modules/openclaw/dist/extensions/zalouser/test-api.js',
                 ];
                 let send;
                 for (const p of paths) {
                   try { const m = await import(p); if (m?.sendMessageZalouser) { send = m.sendMessageZalouser; break; } } catch {}
                 }
                 if (send) {
                   const tid = String(cid).replace(/^group:/, '');
                   await send(tid, text, { isGroup: ig, textMode: 'markdown' });
                 }
               };
            }
            await runCrawlSession(sess.id, sess.groupSlice, reportTo, api, null, profileName);
          });
          cronCount++;
        }
      }
      console.log(`[fb-crawler] Registered ${cronCount} cron sessions across all profiles.`);
    } else {
      console.warn('[fb-crawler] api.scheduleCron not available or no crons defined.');
    }
  },
});

export default plugin;
