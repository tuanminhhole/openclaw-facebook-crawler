import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
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
const STATE_FILE   = path.join(DATA_DIR, 'state.json');
const BLACK_FILE   = path.join(DATA_DIR, 'blacklist_uid.json');
const CONFIG_FILE  = path.join(__dirname, 'config.json');

for (const d of [DATA_DIR, RESULTS_DIR, RAW_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function readJson(file, def = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function loadConfig()    { return readJson(CONFIG_FILE, { adminIds: [], groups: [], rules: {}, cronSchedule: [] }); }
function saveConfig(cfg) { writeJson(CONFIG_FILE, cfg); }
function loadState()     { return readJson(STATE_FILE, { lastRun: null, scanned: [], authorPostCount: {} }); }
function saveState(s)    { writeJson(STATE_FILE, s); }
function loadBlacklist() { return readJson(BLACK_FILE, { uids: [] }); }
function saveBlacklist(b){ writeJson(BLACK_FILE, b); }

function todayKey() { return new Date().toISOString().slice(0, 10); }
function resultsFile() { return path.join(RESULTS_DIR, `${todayKey()}.json`); }
function appendResult(item) {
  const file = resultsFile();
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
function rawFile(groupKey) {
  const ym = new Date().toISOString().slice(0, 7); // YYYY-MM
  return path.join(RAW_DIR, `${groupKey}-${ym}.json`);
}
function loadRaw(groupKey) { return readJson(rawFile(groupKey), []); }
function saveRaw(groupKey, posts) { writeJson(rawFile(groupKey), posts); }

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

// ─── Core crawl logic ─────────────────────────────────────────────────────────
async function runCrawlSession(sessionId, groupSlice, sendReport, api, groupsOverride = null) {
  const cfg   = loadConfig();
  const state = loadState();
  const bl    = loadBlacklist();

  const rules = cfg.rules || {};
  const requireKeywords = rules.requireKeywords || [];
  const blockKeywords = rules.blockKeywords || [];
  const locationsObj = rules.locations || {};
  const extractRegexObj = rules.extractRegex || {};

  const groups = groupsOverride || (groupSlice ? cfg.groups.slice(groupSlice[0], groupSlice[1]) : cfg.groups);
  if (groups.length === 0) {
    console.log(`[fb-crawler] Session ${sessionId}: No groups to scan in this slice.`);
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
      console.log(`[fb-crawler] Session ${sessionId} → ${group.name}`);

      await btExec(`open "${group.url}"`);
      await btExec('wait 4000');

      // ── PHASE 1: Collect raw posts until previous month ──────────────────
      const existingRaw = loadRaw(group.key);
      const existingRawSet = new Set(existingRaw.map(p => p.permalink));
      let allPagePosts = [];
      let reachedOldPosts = false;
      for (let scroll = 0; scroll <= maxScroll && !reachedOldPosts; scroll++) {
        await btExec('evaluate "document.querySelectorAll(\'div[role=button]\').forEach(b => { if(b?.innerText?.includes(\'Xem thêm\')) b.click() })"');
        await btExec('wait 1200');
        const out = await btExec('get_posts');
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
      const newRawPosts = [];
      for (const p of allPagePosts) {
        if (!p.permalink || seenOnPage.has(p.permalink)) continue;
        seenOnPage.add(p.permalink);
        if (!existingRawSet.has(p.permalink)) {
          newRawPosts.push({ permalink: p.permalink, text: p.text, author: p.author, authorUrl: p.authorUrl, time: p.time, scannedAt: new Date().toISOString() });
          existingRaw.push({ permalink: p.permalink, text: p.text, author: p.author, authorUrl: p.authorUrl, time: p.time, scannedAt: new Date().toISOString() });
        }
      }
      saveRaw(group.key, existingRaw);
      console.log(`[fb-crawler] ${group.key}: ${newRawPosts.length} new raw posts (${existingRaw.length} total in store)`);
      let rawPosts = allPagePosts; // keep for compatibility

      // ── PHASE 3: Filter only NEW posts (not in global scannedSet) ─────────
      const uniquePosts = newRawPosts.map(r => ({
        text: r.text, permalink: r.permalink, author: r.author,
        authorUrl: r.authorUrl, time: r.time
      }));

      for (const post of uniquePosts) {
        const text = post.text || '';
        const link = post.permalink || '';
        const author = post.authorUrl || post.author || '';

        scannedSet.add(link);

        if (author && bl.uids.includes(author)) continue;

        // Requirement check: must have sale keywords
        if (requireKeywords.length > 0 && !textContainsAny(text, requireKeywords)) {
          continue;
        }

        // Vehicle keyword check for mixed groups
        const vehicleKws = group.vehicleKeywords || [];
        if (vehicleKws.length > 0 && !textContainsAny(text, vehicleKws)) {
          continue; // Post doesn't mention any of the target vehicle models
        }

        // Smart vehicle check (reject if it's just selling accessories)
        const accessories = ['phuộc', 'baga', 'pô', 'nhông sên', 'mâm', 'lốp', 'vỏ xe', 'đèn', 'mũ bảo hiểm', 'tem', 'kính hậu'];
        const accCount = accessories.filter(a => text.toLowerCase().includes(a)).length;
        if (accCount >= 2 && !text.toLowerCase().includes('nguyên xe') && !text.toLowerCase().includes('cả xe')) {
           skippedPro++; 
           continue; 
        }

        // Block check
        if (blockKeywords.length > 0 && textContainsAny(text, blockKeywords)) {
          skippedPro++;
          if (author) { bl.uids.push(author); saveBlacklist(bl); }
          continue;
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

        appendResult(item);
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
  saveState(state);

  const isLastSession = ['E', 'J', 'O', 'MANUAL'].includes(sessionId);
  let reportStr = `🔍 *Session ${sessionId} hoàn tất*\n✅ Tìm được: ${foundTotal} bài\n🚫 Bị block/Sai mục đích: ${skippedPro}\n📍 Sai vùng: ${skippedLoc}`;
  if (isLastSession || sessionId === 'MANUAL') {
    reportStr = buildDailyReport(foundItems) + `\n\n` + reportStr;
  }

  if (sendReport) await sendReport(reportStr);
}

function buildDailyReport(items) {
  const top = items.slice(-5).map(i => {
    let extra = '';
    for(const [k, v] of Object.entries(i.extracted || {})) {
      if(v) extra += `${k.toUpperCase()}: ${v} | `;
    }
    return `📌 *${i.name}* | 📍 ${i.location}\n${extra}\n🔗 ${i.permalink}`;
  }).join('\n\n');
  return `📋 *TỔNG KẾT PHIÊN*\n\n${items.length} bài hợp lệ tìm được.\n\n${top || 'Chưa có kết quả.'}\n\n💾 Xem đầy đủ: /report`;
}

// ─── Plugin Entry ─────────────────────────────────────────────────────────────
const plugin = definePluginEntry({
  id: 'openclaw-facebook-crawler',
  name: 'Facebook Crawler',
  description: 'Quét group Facebook tự động, bộ lọc tuỳ chỉnh, báo cáo qua Zalo.',

  register(api) {
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

      const reply = (text) => sendMsg(ctx, rawConvId, isGroupMsg, text);

      if (cmd === '/help') {
        await reply(
          `🕷️ *Facebook Crawler — Danh sách lệnh*\n\n` +
          `*/scan* — Quét toàn bộ ${plugCfg.groups.length} groups ngay\n` +
          `*/scan <key|id>* — Quét 1 group theo key hoặc số thứ tự\n` +
          `*/scan session <ID>* — Chạy 1 session cron cụ thể\n` +
          `*/report* — Báo cáo kết quả hôm nay\n` +
          `*/report <YYYY-MM-DD>* — Báo cáo ngày cụ thể\n` +
          `*/blacklist* — Xem danh sách UID bị chặn\n` +
          `*/blacklist remove <uid>* — Xóa UID khỏi blacklist\n` +
          `*/reset* — Xóa lịch sử đã quét, quét lại từ đầu\n` +
          `*/cron* — Xem lịch cron hiện tại\n` +
          `*/groups* — Xem danh sách groups đang theo dõi\n` +
          `*/add-group <key> <tên> <url>* — Thêm group mới\n` +
          `*/remove-group <key|id>* — Xóa group\n` +
          `*/status* — Trạng thái plugin\n` +
          `*/set-notify* — Đặt chat hiện tại nhận báo cáo tự động`
        );
        return { handled: true };
      }

      if (cmd === '/status') {
        const state = loadState();
        const bl    = loadBlacklist();
        const results = readJson(resultsFile(), []);
        await reply(
          `📊 *Trạng thái Facebook Crawler*\n\n` +
          `🕐 Lần quét cuối: ${state.lastRun ? new Date(state.lastRun).toLocaleString('vi-VN') : 'Chưa có'}\n` +
          `🔗 Đã quét: ${(state.scanned || []).length} bài\n` +
          `🚫 Blacklist: ${(bl.uids || []).length} UID\n` +
          `✅ Kết quả hôm nay: ${results.length} bài\n` +
          `📋 Số groups: ${plugCfg.groups.length}`
        );
        return { handled: true };
      }

      if (cmd === '/groups') {
        const lines = plugCfg.groups.map(g => `${g.id}. [${g.key}] ${g.name}`).join('\n');
        await reply(`📋 *Danh sách Groups (${plugCfg.groups.length})*\n\n${lines}`);
        return { handled: true };
      }

      if (cmd === '/add-group') {
        const [, key, ...rest] = parts;
        const url = rest.pop();
        const name = rest.join(' ');
        if (!key || !name || !url?.startsWith('http')) {
          await reply(`⚠️ Cú pháp: /add-group <key> <tên group> <url>`);
          return { handled: true };
        }
        const newId = Math.max(0, ...plugCfg.groups.map(g => g.id)) + 1;
        plugCfg.groups.push({ id: newId, key, name, url });
        saveConfig(plugCfg);
        await reply(`✅ Đã thêm group #${newId} [${key}]: ${name}`);
        return { handled: true };
      }

      if (cmd === '/remove-group') {
        const target = parts[1];
        const before = plugCfg.groups.length;
        plugCfg.groups = plugCfg.groups.filter(g => g.key !== target && String(g.id) !== target);
        saveConfig(plugCfg);
        await reply(before > plugCfg.groups.length ? `✅ Đã xóa group [${target}].` : `⚠️ Không tìm thấy group [${target}].`);
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
        const state = loadState();
        const count = (state.scanned || []).length;
        state.scanned = [];
        state.lastRun = null;
        saveState(state);
        await reply(`🔄 Đã xóa ${count} bài đã quét. Lần quét tiếp sẽ quét lại từ đầu.`);
        return { handled: true };
      }

      if (cmd === '/blacklist') {
        const bl = loadBlacklist();
        if (parts[1] === 'remove' && parts[2]) {
          const before = bl.uids.length;
          bl.uids = bl.uids.filter(u => !u.includes(parts[2]));
          saveBlacklist(bl);
          await reply(before > bl.uids.length ? `✅ Đã xóa UID khỏi blacklist.` : `⚠️ Không tìm thấy UID.`);
        } else {
          const list = bl.uids.slice(-20).map((u, i) => `${i+1}. ${u}`).join('\n');
          await reply(`🚫 *Blacklist (${bl.uids.length} UID)*\n${list || 'Trống.'}`);
        }
        return { handled: true };
      }

      if (cmd === '/cron') {
        const crons = plugCfg.cronSchedule || [];
        const lines = crons.map(s => {
          const gs = plugCfg.groups.slice(s.groupSlice[0], s.groupSlice[1]).map(g => g.key).join(', ');
          return `[${s.id}] ${s.cron} → ${gs}`;
        }).join('\n');
        await reply(`⏰ *Lịch Cron (${crons.length} sessions)*\n\`\`\`\n${lines}\n\`\`\``);
        return { handled: true };
      }

      if (cmd === '/report') {
        const dateKey = parts[1] || todayKey();
        const file = path.join(RESULTS_DIR, `${dateKey}.json`);
        const items = readJson(file, []);
        if (!items.length) {
          await reply(`📭 Chưa có kết quả cho ngày ${dateKey}.`);
          return { handled: true };
        }
        const byRegion = {};
        items.forEach(i => { byRegion[i.location] = (byRegion[i.location] || 0) + 1; });
        const regionStr = Object.entries(byRegion).map(([k,v]) => `${k}: ${v}`).join(' | ');
        const top5 = items.slice(-5).map(i => {
            let extra = '';
            for(const [k, v] of Object.entries(i.extracted || {})) if(v) extra += `${k.toUpperCase()}: ${v} | `;
            return `📌 *${i.name}* | 📍 ${i.location}\n${extra}\n🔗 ${i.permalink}`;
        }).join('\n\n');
        await reply(`📋 *Báo cáo ${dateKey}*\n✅ Tổng: ${items.length} bài\n📍 ${regionStr}\n\n${top5}`);
        return { handled: true };
      }

      if (cmd === '/scan') {
        const arg1 = parts[1]?.toLowerCase();
        const notifyCfg = loadConfig();
        const reportTo = async (text) => {
          const cid = notifyCfg.notifyConversationId || rawConvId;
          const ig  = notifyCfg.notifyIsGroup ?? isGroupMsg;
          await sendMsg(ctx, cid, ig, text);
        };

        if (arg1 === 'session' && parts[2]) {
          const sid = parts[2].toUpperCase();
          const sess = (notifyCfg.cronSchedule || []).find(s => s.id === sid);
          if (!sess) {
            await reply(`⚠️ Session không hợp lệ.`);
            return { handled: true };
          }
          await reply(`🚀 Bắt đầu session ${sid}...`);
          runCrawlSession(sid, sess.groupSlice, reportTo, api).catch(console.error);
          return { handled: true };
        }

        if (arg1) {
          const g = notifyCfg.groups.find(g => g.key === arg1 || String(g.id) === arg1);
          if (!g) {
            await reply(`⚠️ Không tìm thấy group [${arg1}].`);
            return { handled: true };
          }
          await reply(`🔍 Đang quét group: ${g.name}...`);
          runCrawlSession('MANUAL', null, reportTo, api, [g]).catch(console.error);
          return { handled: true };
        }

        await reply(`🚀 Bắt đầu quét toàn bộ ${notifyCfg.groups.length} groups... Mình sẽ báo cáo sau khi xong.`);
        (async () => {
          const numSess = Math.ceil(notifyCfg.groups.length / 5);
          for (let i=0; i<numSess; i++) {
            await runCrawlSession(`S${i+1}`, [i*5, i*5+5], reportTo, api);
          }
        })().catch(console.error);
        return { handled: true };
      }

    }, { priority: 340 });

    const plugCfg = loadConfig();
    const crons = plugCfg.cronSchedule || [];
    if (api.scheduleCron && crons.length > 0) {
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
          await runCrawlSession(sess.id, sess.groupSlice, reportTo, api);
        });
      }
      console.log(`[fb-crawler] Registered ${crons.length} cron sessions.`);
    } else {
      console.warn('[fb-crawler] api.scheduleCron not available or no crons defined.');
    }
  },
});

export default plugin;
