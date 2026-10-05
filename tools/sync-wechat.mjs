#!/usr/bin/env node
/**
 * Hexo 博客 → 微信公众号草稿 同步脚本
 *
 * 用法:
 *   pnpm sync-wechat              同步未同步的文章
 *   pnpm sync-wechat -- --force   强制重新同步所有文章
 *   pnpm sync-wechat -- --dry-run 试运行（不调用微信 API，仅检查转换结果）
 *
 * 前置:
 *   1. 编辑 .env，填入 WECHAT_APPID / WECHAT_APPSECRET
 *   2. 公众号后台 → 设置与开发 → 基本配置 → IP白名单 加入本机出口 IP
 *   3. pnpm install
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, basename, dirname, relative, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import https from 'https';
import Hexo from 'hexo';

import { marked } from 'marked';
import matter from 'gray-matter';

// ========== 路径常量 ==========
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const POSTS_ROOT = join(ROOT, 'source', '_posts');
const POSTS_DIR = join(POSTS_ROOT, 'maoyi_story');
const SOURCE_DIR = join(ROOT, 'source');
const STATE_FILE = join(ROOT, '.wechat-sync.json');
const API = 'https://api.weixin.qq.com';

// ========== 参数 ==========
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const DRY_RUN = args.includes('--dry-run');

// ========== 环境变量 ==========
function getConfig() {
  const env = process.env;
  if (!DRY_RUN && (!env.WECHAT_APPID || !env.WECHAT_APPSECRET)) {
    console.error('错误: .env 中缺少 WECHAT_APPID 或 WECHAT_APPSECRET');
    console.error('请编辑 .env 填写 WECHAT_APPID 和 WECHAT_APPSECRET');
    process.exit(1);
  }
  if (!env.BLOG_URL) {
    throw new Error('请在 .env 中设置 BLOG_URL，作为“阅读原文”的网站地址');
  }
  let blogUrl;
  try {
    blogUrl = new URL(env.BLOG_URL);
  } catch {
    throw new Error('BLOG_URL 不是有效网址');
  }
  if (!['http:', 'https:'].includes(blogUrl.protocol) || blogUrl.search || blogUrl.hash) {
    throw new Error('BLOG_URL 必须是没有查询参数或锚点的 http(s) 网站地址');
  }
  return {
    appId: env.WECHAT_APPID,
    appSecret: env.WECHAT_APPSECRET,
    author: env.WECHAT_AUTHOR || 'Kay Ray',
    blogUrl: blogUrl.href.replace(/\/$/, ''),
    defaultCover: env.WECHAT_DEFAULT_COVER || '',
  };
}

// ========== HTTP 工具 ==========

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    }).on('error', reject);
  });
}

function httpsPost(url, body, contentType, rawPayload) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = rawPayload ?? JSON.stringify(body);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function httpsUpload(url, filePath) {
  const fileBuffer = readFileSync(filePath);
  const fileName = basename(filePath);
  const ext = fileName.split('.').pop().toLowerCase();
  const mimeMap = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png', gif: 'image/gif', bmp: 'image/bmp',
  };
  const mime = mimeMap[ext] || 'application/octet-stream';

  const boundary = '----WB' + Math.random().toString(16).slice(2);
  const header = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="media"; filename="${fileName}"\r\n` +
    `Content-Type: ${mime}\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const payload = Buffer.concat([header, fileBuffer, footer]);

  return httpsPost(url, null, `multipart/form-data; boundary=${boundary}`, payload);
}

// ========== 微信 API ==========

async function getToken(appId, appSecret) {
  const url = `${API}/cgi-bin/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`;
  const res = await httpsGet(url);
  if (res.errcode) {
    if (res.errcode === 40164) {
      throw new Error(
        'IP 不在白名单 (errcode 40164)\n' +
        '→ 查当前出口 IP: curl ifconfig.me\n' +
        '→ 公众号后台 → 设置与开发 → 基本配置 → IP白名单 添加该 IP'
      );
    }
    throw new Error(`获取 access_token 失败: ${res.errcode} ${res.errmsg}`);
  }
  if (!res.access_token) throw new Error('获取 access_token 失败：微信未返回 access_token');
  return res.access_token;
}

async function uploadContentImage(token, filePath) {
  const url = `${API}/cgi-bin/media/uploadimg?access_token=${token}`;
  const res = await httpsUpload(url, filePath);
  if (res.errcode) {
    throw new Error(`图片上传失败 (${basename(filePath)}): ${res.errcode} ${res.errmsg}`);
  }
  if (!res.url) throw new Error(`图片上传失败 (${basename(filePath)})：微信未返回图片 URL`);
  return res.url;
}

async function uploadCoverImage(token, filePath) {
  const url = `${API}/cgi-bin/material/add_material?access_token=${token}&type=image`;
  const res = await httpsUpload(url, filePath);
  if (res.errcode) {
    throw new Error(`封面上传失败: ${res.errcode} ${res.errmsg}`);
  }
  if (!res.media_id) throw new Error('封面上传失败：微信未返回 media_id');
  return res.media_id;
}

async function createDraft(token, article) {
  const url = `${API}/cgi-bin/draft/add?access_token=${token}`;
  const res = await httpsPost(url, { articles: [article] }, 'application/json');
  if (res.errcode) {
    throw new Error(`创建草稿失败: ${res.errcode} ${res.errmsg}`);
  }
  if (!res.media_id) throw new Error('创建草稿失败：微信未返回 media_id');
  return res.media_id;
}

// ========== Markdown → 微信 HTML ==========

function mdToWechatHtml(md) {
  marked.setOptions({ html: true, gfm: true, breaks: false });
  let html = marked.parse(md);

  // 微信不支持外部 CSS，必须用 inline style
  const replacements = [
    [/<p>/g, '<p style="margin:10px 0;line-height:1.8;font-size:15px;color:#333;">'],
    [/<h1>/g, '<h1 style="font-size:20px;font-weight:bold;margin:24px 0 10px;color:#222;">'],
    [/<h2>/g, '<h2 style="font-size:18px;font-weight:bold;margin:20px 0 8px;color:#222;">'],
    [/<h3>/g, '<h3 style="font-size:16px;font-weight:bold;margin:18px 0 8px;color:#222;">'],
    [/<h4>/g, '<h4 style="font-size:15px;font-weight:bold;margin:16px 0 6px;color:#222;">'],
    [/<blockquote>/g, '<blockquote style="border-left:3px solid #ccc;padding:4px 12px;margin:12px 0;color:#666;font-size:14px;background:#f9f9f9;">'],
    [/<pre>/g, '<pre style="background:#f5f5f5;padding:12px;border-radius:6px;overflow-x:auto;font-size:13px;line-height:1.6;">'],
    [/<ul>/g, '<ul style="padding-left:20px;margin:10px 0;line-height:1.8;font-size:15px;color:#333;">'],
    [/<ol>/g, '<ol style="padding-left:20px;margin:10px 0;line-height:1.8;font-size:15px;color:#333;">'],
    [/<a /g, '<a style="color:#576b95;text-decoration:none;" '],
    [/<img /g, '<img style="max-width:100%;height:auto;display:block;margin:12px auto;" '],
  ];
  for (const [re, rep] of replacements) {
    html = html.replace(re, rep);
  }

  // <center> → <section style="text-align:center">（微信对 center 标签支持不稳定）
  html = html.replace(
    /<center\s+style="([^"]*)">/g,
    (_, s) => `<section style="text-align:center;${s}">`
  );
  html = html.replace(/<center>/g, '<section style="text-align:center;">');
  html = html.replace(/<\/center>/g, '</section>');

  return html;
}

// ========== 图片处理 ==========

function extractImages(html) {
  const images = [];
  const re = /<img\b[^>]*\s+src\s*=\s*(["'])(.*?)\1/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const src = m[2];
    if (/^(https?:)?\/\//i.test(src) || /^data:/i.test(src)) continue;
    const localPath = src.startsWith('/')
      ? join(SOURCE_DIR, src.slice(1))
      : join(SOURCE_DIR, src);
    images.push({ src, localPath });
  }
  return images;
}

async function processImages(html, images, token) {
  for (const img of images) {
    if (!existsSync(img.localPath)) {
      throw new Error(`图片不存在，草稿未创建: ${img.localPath}`);
    }
    if (DRY_RUN) {
      console.log(`  [dry-run] 图片待上传: ${basename(img.localPath)}`);
      continue;
    }
    const wxUrl = await uploadContentImage(token, img.localPath);
    html = html.replaceAll(img.src, wxUrl);
    console.log(`  图片已上传: ${basename(img.localPath)}`);
  }
  return html;
}

// ========== 同步状态 ==========

function loadState() {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  }
  return { synced_posts: {} };
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function md5(s) {
  return createHash('md5').update(s).digest('hex');
}

// ========== 辅助函数 ==========

function buildDigest(body) {
  const text = body
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*>`~_-]/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= 120) return text;
  let len = 120;
  while (len > 0 && (buf[len] & 0xc0) === 0x80) len--;
  return buf.subarray(0, len).toString('utf-8') + '...';
}

function buildSourceUrl(blogUrl, postPath) {
  return new URL(postPath, `${blogUrl}/`).href;
}

function renderPostLinks(md, links, blogUrl) {
  return md.replace(/\{%\s*post_link\s+([^\s%]+)(?:\s+(['"])(.*?)\2)?\s*%\}/g, (_, slug, _quote, label) => {
    const target = links.get(slug);
    if (!target) throw new Error(`找不到站内文章链接: ${slug}`);
    const title = (label || target.title).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const href = buildSourceUrl(blogUrl, target.path);
    return `<a href="${href}">${title}</a>`;
  });
}

async function loadPostPaths() {
  const hexo = new Hexo(ROOT, { silent: true, safe: true });
  try {
    await hexo.init();
    await hexo.load();
    const paths = new Map();
    const links = new Map();
    for (const post of hexo.model('Post').find({}).toArray()) {
      paths.set(post.source.replace(/\\/g, '/'), post.path);
      const slug = post.source.replace(/\\/g, '/').replace(/^_posts\//, '').replace(/\.[^.]+$/, '');
      links.set(slug, { path: post.path, title: post.title });
    }
    return { paths, links };
  } finally {
    await hexo.exit();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ========== 主流程 ==========

async function main() {
  const config = getConfig();
  console.log('=== Hexo → 微信公众号草稿同步 ===\n');
  if (DRY_RUN) console.log('[试运行模式] 不会调用微信 API\n');

  const state = loadState();
  const { paths: postPaths, links: postLinks } = await loadPostPaths();

  let token = '';
  if (!DRY_RUN) {
    console.log('获取 access_token...');
    token = await getToken(config.appId, config.appSecret);
    console.log('access_token 获取成功\n');
  }

  const posts = readdirSync(POSTS_DIR).filter((f) => f.endsWith('.md'));
  console.log(`扫描到 ${posts.length} 篇文章\n`);

  let synced = 0, skipped = 0, failed = 0;

  for (const fileName of posts) {
    const filePath = join(POSTS_DIR, fileName);
    const raw = readFileSync(filePath, 'utf-8');
    const { data: fm, content: body } = matter(raw);
    const title = fm.title || fileName.replace(/\.md$/, '');
    const source = `_posts/${relative(POSTS_ROOT, filePath).replace(/\\/g, '/')}`;
    const postPath = postPaths.get(source);
    if (!postPath) {
      console.error(`[失败] ${fileName}：Hexo 未生成这篇文章的路径`);
      failed++;
      continue;
    }
    const sourceUrl = buildSourceUrl(config.blogUrl, postPath);

    const hash = md5(raw);
    const prev = state.synced_posts[fileName];
    if (prev && prev.content_hash === hash && prev.source_url === sourceUrl && !FORCE) {
      console.log(`[跳过] ${fileName}（已同步）`);
      skipped++;
      continue;
    }

    console.log(`[同步] ${fileName} — ${title}`);

    try {
      // 1. Markdown → 微信 HTML
      const postLinkCount = (body.match(/\{%\s*post_link\b/g) || []).length;
      const renderedBody = renderPostLinks(body, postLinks, config.blogUrl);
      if (/\{%\s*post_link\b/.test(renderedBody)) {
        throw new Error('有未能解析的 post_link 标签，草稿未创建');
      }
      let html = mdToWechatHtml(renderedBody);

      // 2. 图片上传 & URL 替换
      const imgs = extractImages(html);
      if (imgs.length > 0) {
        console.log(`  处理 ${imgs.length} 张图片...`);
        html = await processImages(html, imgs, token);
      }

      // 3. 封面图（第一张图或默认封面）
      const defaultCoverPath = config.defaultCover
        ? (isAbsolute(config.defaultCover) ? config.defaultCover : join(ROOT, config.defaultCover))
        : '';
      const coverPath =
        imgs.length > 0 && existsSync(imgs[0].localPath)
          ? imgs[0].localPath
          : defaultCoverPath && existsSync(defaultCoverPath)
            ? defaultCoverPath
            : '';

      let thumbId = '';
      if (coverPath) {
        if (DRY_RUN) {
          console.log(`  [dry-run] 封面待上传: ${basename(coverPath)}`);
        } else {
          thumbId = await uploadCoverImage(token, coverPath);
          console.log('  封面已上传');
        }
      } else if (!DRY_RUN) {
        console.warn('  ⚠ 无封面图（文章无图片且未设 WECHAT_DEFAULT_COVER），跳过');
        skipped++;
        continue;
      }

      // 4. 创建草稿
      const article = {
        title,
        author: config.author,
        digest: buildDigest(body),
        content: html,
        content_source_url: sourceUrl,
        thumb_media_id: thumbId,
        need_open_comment: 0,
        only_fans_can_comment: 0,
      };

      if (DRY_RUN) {
        console.log(`  [dry-run] 将创建草稿: "${title}"`);
        console.log(`  [dry-run] 摘要: ${article.digest.slice(0, 50)}...`);
        console.log(`  [dry-run] 阅读原文: ${article.content_source_url}`);
        if (postLinkCount) console.log(`  [dry-run] 已转换站内链接: ${postLinkCount}`);
        console.log(`  [dry-run] 正文: ${html.length} 字符`);
      } else {
        const draftId = await createDraft(token, article);
        state.synced_posts[fileName] = {
          media_id: draftId,
          content_hash: hash,
          source_url: sourceUrl,
          synced_at: new Date().toISOString(),
          title,
        };
        saveState(state);
        console.log(`  草稿已创建: ${draftId}`);
      }
      synced++;
    } catch (err) {
      console.error(`  ✗ ${err.message}`);
      failed++;
    }

    if (!DRY_RUN) await sleep(1000);
    console.log();
  }

  console.log('=== 完成 ===');
  console.log(`同步: ${synced} | 跳过: ${skipped} | 失败: ${failed}`);
  if (!DRY_RUN && synced > 0) {
    console.log('\n下一步: 登录 mp.weixin.qq.com → 草稿箱 → 预览 → 发布');
  }
}

main().catch((err) => {
  console.error('致命错误:', err.stack || err.message);
  process.exit(1);
});
