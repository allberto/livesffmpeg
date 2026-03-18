
import express from "express";
import schedule from "node-schedule";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";
import os from "os";

dotenv.config();
process.env.TZ = process.env.TZ || "America/Mexico_City";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = Number(process.env.PORT || 8080);

const CORTINILLAS_DIR = process.env.CORTINILLAS_DIR || "./cortinillas";
const VIDEOS_DIR = process.env.VIDEOS_DIR || "./videos";
const LOG_DIR = process.env.LOG_DIR || "./logs";

const DEFAULT_RTMP_URL = process.env.RTMP_URL || "";
const RTMP_DIRECTO = "rtmp://104.214.54.242/exatv2/exatvonline2";
const RTMP_FB_BASE = "rtmps://live-api-s.facebook.com:443/rtmp/";

const PUSHOVER_USER = process.env.PUSHOVER_USER || "";
const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN || "";

// Perfil de encoding — defaults optimizados para Raspberry Pi 5 (720p estable)
const OUT_WIDTH = Number(process.env.OUT_WIDTH || 1280);
const OUT_HEIGHT = Number(process.env.OUT_HEIGHT || 720);
const OUT_FPS = Number(process.env.OUT_FPS || 30);
const VIDEO_BITRATE = process.env.VIDEO_BITRATE || "3000k";
const AUDIO_BITRATE = process.env.AUDIO_BITRATE || "96k";
const AUDIO_RATE = Number(process.env.AUDIO_RATE || 48000);
const GOP = Number(process.env.GOP || 60);
const PRESET = process.env.PRESET || "ultrafast";
const THREADS = Number(process.env.FFMPEG_THREADS || 3); // dejar 1 core libre para OS/tunnels

// --- Detección de encoder HW (h264_v4l2m2m en Raspberry Pi) ---
// FFMPEG_ENCODER=auto (default) detecta | h264_v4l2m2m = forzar HW | libx264 = forzar SW
function detectHwEncoder() {
  try {
    // Paso 1: verificar que aparece en la lista de encoders
    const list = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8", timeout: 5000 });
    if (!(list.stdout || "").includes("h264_v4l2m2m")) return false;

    // Paso 2: prueba real — encodear 1 frame negro para confirmar que funciona
    const test = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=black:s=320x240:d=0.1",
      "-frames:v", "1", "-c:v", "h264_v4l2m2m", "-f", "null", "-"
    ], { encoding: "utf8", timeout: 10000 });
    if (test.status !== 0) {
      console.log(`[HW-DETECT] h264_v4l2m2m listado pero test falló: ${(test.stderr || "").trim()}`);
      return false;
    }
    console.log("[HW-DETECT] h264_v4l2m2m test OK — usando encoder HW");
    return true;
  } catch (e) {
    console.log(`[HW-DETECT] error: ${e?.message}`);
    return false;
  }
}
const ENCODER_ENV = (process.env.FFMPEG_ENCODER || "auto").toLowerCase();
const USE_HW = ENCODER_ENV === "auto" ? detectHwEncoder() : ENCODER_ENV === "h264_v4l2m2m";
const VIDEO_ENCODER = USE_HW ? "h264_v4l2m2m" : "libx264";
const PIX_FMT = USE_HW ? "nv12" : "yuv420p";

console.log("=== PLAYOUT ENCODING CONFIG ===");
console.log(`  Encoder: ${VIDEO_ENCODER} (env=${ENCODER_ENV}, hw=${USE_HW})`);
console.log(`  Output:  ${OUT_WIDTH}x${OUT_HEIGHT} @ ${OUT_FPS}fps`);
console.log(`  Bitrate: video=${VIDEO_BITRATE} audio=${AUDIO_BITRATE}`);
console.log(`  PixFmt:  ${PIX_FMT} | Preset: ${PRESET} | Threads: ${THREADS}`);
console.log("===============================");

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(CORTINILLAS_DIR, { recursive: true });
fs.mkdirSync(VIDEOS_DIR, { recursive: true });

const state = {
  current: null, // { id, config, jobs[], procs, status, createdAt, lastHeartbeat }
  history: []
};

// --- Estado de compresión de videos ---
const compresionState = {
  active: null, // { filename, outputName, startedAt, progress, status, pid, sizeBefore, sizeAfter, error }
  history: []   // últimas 5 compresiones completadas
};

const SCHEDULED_STATE_FILE = path.join(LOG_DIR, ".scheduled.json");

function saveScheduledState() {
  const ctx = state.current;
  if (!ctx || !["scheduled", "preview"].includes(ctx.status)) return;
  try {
    const payload = {
      id: ctx.id,
      createdAt: ctx.createdAt,
      config: { ...ctx.config }
    };
    fs.writeFileSync(SCHEDULED_STATE_FILE, JSON.stringify(payload, null, 0), "utf8");
  } catch (e) {
    console.error("No se pudo guardar estado programado:", e?.message);
  }
}

function clearScheduledStateFile() {
  try {
    if (fs.existsSync(SCHEDULED_STATE_FILE)) fs.unlinkSync(SCHEDULED_STATE_FILE);
  } catch {}
}

function loadScheduledState() {
  try {
    if (!fs.existsSync(SCHEDULED_STATE_FILE)) return null;
    const raw = fs.readFileSync(SCHEDULED_STATE_FILE, "utf8");
    const data = JSON.parse(raw);
    if (!data?.id || !data?.config?.launchDateTime) return null;
    const launch = new Date(data.config.launchDateTime);
    if (isNaN(+launch) || +launch <= Date.now()) {
      clearScheduledStateFile();
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function nowISO() { return new Date().toISOString(); }
function logFile(id) { return path.join(LOG_DIR, `${id}.log`); }

function fmtDur(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return h > 0 ? `${h}h${String(m).padStart(2,"0")}m${String(s).padStart(2,"0")}s`
               : `${m}m${String(s).padStart(2,"0")}s`;
}

function fmtTime(date) {
  return date.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function logLine(id, line) {
  fs.appendFileSync(logFile(id), `[${nowISO()}] ${line}\n`);
}

function safeText(s) {
  return String(s || "").replace(/[<>&]/g, c => ({ "<":"&lt;", ">":"&gt;", "&":"&amp;" }[c]));
}

async function pushover(title, message, priority = 0) {
  if (!PUSHOVER_USER || !PUSHOVER_TOKEN) return;
  try {
    await new Promise((resolve) => {
      const p = spawn("curl", [
        "-s", "-X", "POST",
        "--form-string", `token=${PUSHOVER_TOKEN}`,
        "--form-string", `user=${PUSHOVER_USER}`,
        "--form-string", `title=${title}`,
        "--form-string", `message=${message}`,
        "--form-string", `priority=${priority}`,
        "https://api.pushover.net/1/messages.json"
      ], { stdio: "ignore" });
      p.on("close", () => resolve());
      p.on("error", () => resolve());
    });
  } catch {}
}

function listMedia(dir) {
  const exts = /\.(mp4|mov|mkv|m4v)$/i;
  return fs.readdirSync(dir)
    .filter(f => exts.test(f))
    .map(f => {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      return { name: f, full, mtime: st.mtimeMs, size: st.size };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function listCortinillas() { return listMedia(CORTINILLAS_DIR).map(x => x.name).sort(); }
function listVideos() { return listMedia(VIDEOS_DIR); }

function pickLatestVideo() {
  const vids = listVideos();
  return vids[0] || null;
}

function probeVideo(filePath) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    p.stdout.on("data", d => { out += d; });
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exit code ${code}`));
      try {
        const info = JSON.parse(out);
        const duration = parseFloat(info.format?.duration || "0");
        const hasAudio = (info.streams || []).some(s => s.codec_type === "audio");
        const vs = (info.streams || []).find(s => s.codec_type === "video");
        const width = vs?.width || 0;
        const height = vs?.height || 0;
        let fps = 0;
        if (vs?.r_frame_rate) {
          const [num, den] = vs.r_frame_rate.split("/").map(Number);
          if (den) fps = num / den;
        }
        resolve({ duration, hasAudio, width, height, fps });
      } catch (e) {
        reject(e);
      }
    });
    p.on("error", reject);
  });
}

function stopProc(proc) {
  if (!proc || proc.killed) return;
  try {
    proc.kill("SIGINT");
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 2500);
  } catch {}
}

// Filtro de video adaptativo: omite scale/pad/fps si el input ya coincide con el target
function buildVf(inputW, inputH, inputFps) {
  const parts = [];
  const needsScale = !inputW || !inputH || inputW !== OUT_WIDTH || inputH !== OUT_HEIGHT;
  if (needsScale) {
    parts.push(`scale=${OUT_WIDTH}:${OUT_HEIGHT}:force_original_aspect_ratio=decrease:flags=fast_bilinear`);
    parts.push(`pad=${OUT_WIDTH}:${OUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2`);
  }
  if (!inputFps || Math.abs(inputFps - OUT_FPS) > 1) {
    parts.push(`fps=${OUT_FPS}`);
  }
  parts.push(`format=${PIX_FMT}`);
  return parts.join(",");
}
// Fallback completo para cortinillas (no se probean)
const VF_FULL = buildVf();

function reencodeArgs(inputPath, rtmpUrl, extraInputArgs = [], durationSeconds = null, loop = false) {
  // Re-encode to stable profile (H.264 + AAC) so switching never breaks RTMP.
  // durationSeconds: if set, stop after that time (for preview/post).
  const args = [];
  if (loop) args.push("-stream_loop", "-1");
  args.push(...extraInputArgs);
  args.push("-re", "-i", inputPath);
  if (durationSeconds !== null) args.push("-t", String(durationSeconds));

  args.push(
    "-vf", VF_FULL,
    ...ENCODE_OPTS,
    "-f", "flv",
    rtmpUrl
  );

  return args;
}

// --- Encode options shared by all feeders ---
// SW siempre disponible como fallback
const SW_ENCODE_OPTS = [
  "-c:v", "libx264",
  "-preset", PRESET,
  "-tune", "zerolatency",
  "-bf", "0",
  "-threads", String(THREADS),
  "-b:v", VIDEO_BITRATE,
  "-maxrate", VIDEO_BITRATE,
  "-bufsize", String(parseInt(VIDEO_BITRATE) * 2) + "k",
  "-pix_fmt", "yuv420p",
  "-g", String(GOP),
  "-keyint_min", String(GOP),
  "-sc_threshold", "0",
  "-c:a", "aac",
  "-b:a", AUDIO_BITRATE,
  "-ar", String(AUDIO_RATE),
  "-ac", "2"
];

const HW_ENCODE_OPTS = [
  "-c:v", "h264_v4l2m2m",
  "-pix_fmt", "nv12",
  "-threads", String(THREADS),
  "-b:v", VIDEO_BITRATE,
  "-g", String(GOP),
  "-c:a", "aac",
  "-b:a", AUDIO_BITRATE,
  "-ar", String(AUDIO_RATE),
  "-ac", "2"
];

const ENCODE_OPTS = USE_HW ? HW_ENCODE_OPTS : SW_ENCODE_OPTS;

function buildVfForOpts(encOpts, inputW, inputH, inputFps) {
  const isHw = encOpts === HW_ENCODE_OPTS;
  const pf = isHw ? "nv12" : "yuv420p";
  const parts = [];
  const needsScale = !inputW || !inputH || inputW !== OUT_WIDTH || inputH !== OUT_HEIGHT;
  if (needsScale) {
    parts.push(`scale=${OUT_WIDTH}:${OUT_HEIGHT}:force_original_aspect_ratio=decrease:flags=fast_bilinear`);
    parts.push(`pad=${OUT_WIDTH}:${OUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2`);
  }
  if (!inputFps || Math.abs(inputFps - OUT_FPS) > 1) {
    parts.push(`fps=${OUT_FPS}`);
  }
  parts.push(`format=${pf}`);
  return parts.join(",");
}

function cortFeederArgs(cortPath, durationSec, tsOffset, encOpts) {
  const eo = encOpts || ENCODE_OPTS;
  return [
    "-stream_loop", "-1", "-re", "-i", cortPath,
    "-f", "lavfi", "-i", `anullsrc=cl=stereo:r=${AUDIO_RATE}`,
    "-map", "0:v", "-map", "1:a",
    "-t", String(durationSec),
    "-vf", buildVfForOpts(eo),
    ...eo,
    "-output_ts_offset", String(tsOffset),
    "-f", "mpegts",
    "-mpegts_flags", "resend_headers",
    "pipe:1"
  ];
}

function videoFeederArgs(videoPath, tsOffset, hasAudio, probe, encOpts) {
  const eo = encOpts || ENCODE_OPTS;
  const args = ["-re", "-i", videoPath];
  if (!hasAudio) {
    args.push("-f", "lavfi", "-i", `anullsrc=cl=stereo:r=${AUDIO_RATE}`);
    args.push("-map", "0:v", "-map", "1:a");
  }
  const vf = probe ? buildVfForOpts(eo, probe.width, probe.height, probe.fps) : buildVfForOpts(eo);
  args.push(
    "-vf", vf,
    ...eo,
    "-output_ts_offset", String(tsOffset),
    "-f", "mpegts",
    "-mpegts_flags", "resend_headers",
    "pipe:1"
  );
  return args;
}

function muxerArgs(rtmpUrl) {
  return [
    "-fflags", "+discardcorrupt",
    "-f", "mpegts", "-i", "pipe:0",
    "-c", "copy",
    "-bsf:a", "aac_adtstoasc",
    "-bsf:v", "dump_extra=freq=keyframe",
    "-f", "flv",
    "-flvflags", "no_duration_filesize",   // evita seek en pipe (imposible en RTMP)
    "-rw_timeout", "15000000",             // 15s timeout de escritura RTMP (falla rápido)
    rtmpUrl
  ];
}

function spawnFfmpeg(args, id, tag, onExit, stdioOverride) {
  const p = spawn("ffmpeg", args, { stdio: stdioOverride || ["ignore", "pipe", "pipe"] });
  // Bajar prioridad de FFmpeg para que OS/tunnels/SSH mantengan responsividad
  try { os.setPriority(p.pid, 10); } catch {}

  const onData = (d) => {
    const s = String(d).trim();
    if (!s) return;
    logLine(id, `[${tag}] ${s}`);
    state.current && (state.current.lastHeartbeat = Date.now());
  };

  if (p.stdout) p.stdout.on("data", onData);
  if (p.stderr) p.stderr.on("data", onData);

  p.on("close", async (code) => {
    logLine(id, `[${tag}] EXIT code=${code}`);
    if (onExit) onExit(code);
  });

  p.on("error", async (err) => {
    logLine(id, `[${tag}] ERROR ${err?.message || err}`);
    await pushover("⚠️ Falla FFmpeg", `Evento ${id}\nProceso ${tag}\nError: ${err?.message || err}`, 1);
  });

  return p;
}

function runSeamlessPipeline(cortPath, videoPath, rtmpUrl, previewSec, postSec, probeResult, id, ctx) {
  const videoDur = probeResult.duration;
  const hasAudio = probeResult.hasAudio;
  let cancelled = false;

  // 1. Spawn muxer — stays alive for the entire transmission
  const muxer = spawnFfmpeg(muxerArgs(rtmpUrl), id, "MUXER", async (code) => {
    if (cancelled) return;
    ctx.status = "finished";
    logLine(id, `MUXER EXIT code=${code}`);
    if (code !== 0) {
      await pushover("⚠️ Stream terminó con error", `Evento ${id}\nMuxer salió con code=${code}`, 1);
    } else {
      await pushover("Transmisión terminada", `Evento ${id}\nFin completo.`);
    }
    state.history.unshift({ id, endedAt: nowISO(), config: ctx.config });
    state.current = null;
    clearScheduledStateFile();
  }, ["pipe", "ignore", "pipe"]); // stdin=pipe, stdout=ignore, stderr=pipe

  ctx.procs.muxer = muxer;

  // Track si tuvimos que caer a SW (para no reintentar en cada feeder)
  let activeEncOpts = ENCODE_OPTS;
  let fellBackToSW = false;

  const runFeeder = (args, tag, expectedDurSec) => {
    return new Promise((resolve, reject) => {
      ctx.live.phase = tag;
      ctx.live.feederStartedAt = Date.now();
      ctx.live.feederDurSec = expectedDurSec;
      ctx.live.ffmpegTimeSec = 0;
      ctx.live.delaySec = 0;
      const spawnedAt = Date.now();

      const feeder = spawnFfmpeg(args, id, tag, (code) => {
        ctx.procs.feeder = null;
        if (code !== 0 && !cancelled) {
          const elapsed = Date.now() - spawnedAt;
          reject(Object.assign(new Error(`${tag} exit code=${code}`), { fastFail: elapsed < 5000 }));
        } else {
          resolve();
        }
      }, ["ignore", "pipe", "pipe"]); // stdin=ignore, stdout=pipe (mpegts), stderr=pipe (logs)

      // Parse time= from FFmpeg progress output to track delay
      feeder.stderr.on("data", (d) => {
        const m = String(d).match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m) {
          const t = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
          ctx.live.ffmpegTimeSec = t;
          const wallElapsed = (Date.now() - ctx.live.feederStartedAt) / 1000;
          ctx.live.delaySec = Math.max(0, +(wallElapsed - t).toFixed(1));
        }
      });

      ctx.procs.feeder = feeder;
      feeder.stdout.on("error", () => {});
      muxer.stdin.on("error", () => {});
      feeder.stdout.pipe(muxer.stdin, { end: false });
    });
  };

  const pipeline = async () => {
    try {
      let offset = 0;

      // Feeder 1: cortinilla pre (skip if previewSec <= 0)
      if (previewSec > 0) {
        ctx.status = "preview";
        logLine(id, `FEEDER CORT-PRE start (${previewSec}s, offset=${offset})`);
        try {
          await runFeeder(cortFeederArgs(cortPath, previewSec, offset, activeEncOpts), "CORT-PRE", previewSec);
        } catch (e) {
          if (e.fastFail && USE_HW && !fellBackToSW) {
            fellBackToSW = true;
            activeEncOpts = SW_ENCODE_OPTS;
            logLine(id, `⚠ HW encoder falló rápido — fallback a libx264`);
            await pushover("⚠️ HW encoder falló", `Evento ${id}\nCayendo a libx264 (software)`, 1);
            await runFeeder(cortFeederArgs(cortPath, previewSec, offset, SW_ENCODE_OPTS), "CORT-PRE", previewSec);
          } else { throw e; }
        }
        offset += previewSec;
      }

      // Feeder 2: video principal
      ctx.status = "main";
      const videoEndEst = new Date(Date.now() + videoDur * 1000);
      logLine(id, `FEEDER VIDEO start (dur=${videoDur}s, offset=${offset}, estEnd=${videoEndEst.toISOString()})`);
      await pushover("Video en vivo", `Evento ${id}\nVideo: ${path.basename(videoPath)}\nDuración: ${fmtDur(videoDur)}\nTermina aprox: ${fmtTime(videoEndEst)}`);
      try {
        await runFeeder(videoFeederArgs(videoPath, offset, hasAudio, probeResult, activeEncOpts), "VIDEO", videoDur);
      } catch (e) {
        if (e.fastFail && USE_HW && !fellBackToSW) {
          fellBackToSW = true;
          activeEncOpts = SW_ENCODE_OPTS;
          logLine(id, `⚠ HW encoder falló rápido — fallback a libx264`);
          await pushover("⚠️ HW encoder falló", `Evento ${id}\nCayendo a libx264 (software)`, 1);
          await runFeeder(videoFeederArgs(videoPath, offset, hasAudio, probeResult, SW_ENCODE_OPTS), "VIDEO", videoDur);
        } else { throw e; }
      }
      offset += videoDur;

      // Notificar que el video terminó
      logLine(id, `VIDEO FINISHED`);
      await pushover("Video terminó", `Evento ${id}\nVideo: ${path.basename(videoPath)}\nDuración real: ${fmtDur(videoDur)}${postSec > 0 ? `\nCortinilla post: ${fmtDur(postSec)}` : "\nFin de transmisión."}`);

      // Feeder 3: cortinilla post (skip if postSec <= 0)
      if (postSec > 0) {
        ctx.status = "post";
        logLine(id, `FEEDER CORT-POST start (${postSec}s, offset=${offset})`);
        await runFeeder(cortFeederArgs(cortPath, postSec, offset, activeEncOpts), "CORT-POST", postSec);
      }

      // All feeders done — close muxer stdin to finish RTMP
      logLine(id, `ALL FEEDERS DONE — closing muxer stdin`);
      muxer.stdin.end();
    } catch (err) {
      if (cancelled) return;
      logLine(id, `PIPELINE ERROR: ${err?.message || err}`);
      await pushover("⚠️ Pipeline falló", `Evento ${id}\n${err?.message || err}`, 1);
      stopProc(muxer);
    }
  };

  // Expose cancel helper
  ctx._cancelPipeline = () => {
    cancelled = true;
    stopProc(ctx.procs.feeder);
    stopProc(ctx.procs.muxer);
  };

  pipeline();
}

function validateRtmpUrl(url) {
  const u = String(url || "").trim();
  if (!u) return null;
  if (!/^rtmps?:\/\//i.test(u)) return null;
  return u;
}

function scheduleEvent(config, opts = {}) {
  if (state.current) throw new Error("Ya hay un evento programado/en curso. Cancélalo antes de crear otro.");

  const id = opts.restoreId || `evt_${Date.now()}`;
  const { launchDateTime, cortinillaName, previewMinutes, postMinutes, rtmpUrl, videoName, streamDest } = config;

  const launch = new Date(launchDateTime);
  if (isNaN(+launch)) throw new Error("launchDateTime inválido.");

  const rtmp = validateRtmpUrl(rtmpUrl) || validateRtmpUrl(DEFAULT_RTMP_URL);
  if (!rtmp) throw new Error("RTMP_URL inválido. Pégalo en la UI o configúralo en .env");

  const cortPath = path.join(CORTINILLAS_DIR, cortinillaName);
  if (!fs.existsSync(cortPath)) throw new Error("No existe esa cortinilla.");

  const videos = listVideos();
  let picked = null;
  if (videoName) picked = videos.find(v => v.name === videoName) || null;
  if (!picked) picked = pickLatestVideo();
  if (!picked) throw new Error("No hay video en la carpeta /videos.");

  const previewStart = new Date(+launch - previewMinutes * 60_000);
  const oneMinBefore = new Date(+launch - 60_000);

  const ctx = {
    id,
    createdAt: nowISO(),
    status: "scheduled",
    lastHeartbeat: Date.now(),
    config: {
      launchDateTime,
      cortinillaName,
      previewMinutes,
      postMinutes,
      videoPicked: picked.name,
      streamDest: streamDest || (rtmpUrl === RTMP_DIRECTO ? "directo" : "fb")
      // rtmpUrl NO se escribe a disco (solo memoria) para no filtrar keys.
    },
    secret: { rtmp },
    jobs: [],
    procs: { muxer: null, feeder: null },
    _cancelPipeline: null,
    live: {
      pipelineStartedAt: null,
      phase: null,
      feederStartedAt: null,
      feederDurSec: null,
      ffmpegTimeSec: 0,
      videoDurSec: null,
      estEndAt: null,
      videoEndsAt: null,
      delaySec: 0
    }
  };

  logLine(id, `CREATED config=${JSON.stringify(ctx.config)}`);
  pushover("Playout programado", `Evento ${id}\nVideo: ${picked.name}\nCortinilla: ${cortinillaName}\nLaunch: ${launch.toString()}`);

  const now = Date.now();
  const postSec = postMinutes * 60;

  const runPipeline = async () => {
    // Calcular effectivePreviewSec al momento de arrancar (ajusta si empieza tarde)
    const effectivePreviewSec = Math.max(0, Math.round((+launch - Date.now()) / 1000));
    ctx.status = effectivePreviewSec > 0 ? "preview" : "main";
    logLine(id, `PIPELINE START (previewSec=${effectivePreviewSec}, postSec=${postSec})`);
    await pushover("Pipeline inició", `Evento ${id}\nCortinilla: ${cortinillaName}\nVideo: ${picked.name}\nPreview: ${effectivePreviewSec}s`);

    try {
      const probeResult = await probeVideo(picked.full);
      const videoDurSec = probeResult.duration;
      const totalSec = effectivePreviewSec + videoDurSec + postSec;
      const estEnd = new Date(Date.now() + totalSec * 1000);

      ctx.live.pipelineStartedAt = Date.now();
      ctx.live.videoDurSec = videoDurSec;
      ctx.live.estEndAt = estEnd.toISOString();
      // Hora exacta en que termina el video (antes de cortinilla post)
      const videoEndTime = new Date(Date.now() + (effectivePreviewSec + videoDurSec) * 1000);
      ctx.live.videoEndsAt = videoEndTime.toISOString();

      logLine(id, `PROBE duration=${videoDurSec} hasAudio=${probeResult.hasAudio} ${probeResult.width}x${probeResult.height}@${Math.round(probeResult.fps)}fps estEnd=${estEnd.toISOString()}`);
      await pushover("Pipeline info", `Evento ${id}\nDuración video: ${fmtDur(videoDurSec)}\nRes: ${probeResult.width}x${probeResult.height}\nFin estimado: ${fmtTime(estEnd)}\nTotal stream: ${fmtDur(totalSec)}`);
      runSeamlessPipeline(cortPath, picked.full, ctx.secret.rtmp, effectivePreviewSec, postSec, probeResult, id, ctx);
    } catch (err) {
      logLine(id, `PROBE/PIPELINE ERROR: ${err?.message || err}`);
      await pushover("⚠️ Error al iniciar pipeline", `Evento ${id}\n${err?.message || err}`, 1);
      ctx.status = "finished";
      state.history.unshift({ id, endedAt: nowISO(), config: ctx.config });
      state.current = null;
      clearScheduledStateFile();
    }
  };

  // Preview: si la hora de preview ya pasó, arrancar ahora; si no, programar
  let jobPreview = null;
  if (+previewStart <= now) {
    logLine(id, `PIPELINE START (inmediato: hora de preview ya había pasado)`);
    setImmediate(runPipeline);
  } else {
    jobPreview = schedule.scheduleJob(previewStart, runPipeline);
  }

  // 1 minute before (solo programar si sigue en el futuro)
  let jobOneMin = null;
  if (+oneMinBefore > now) {
    jobOneMin = schedule.scheduleJob(oneMinBefore, async () => {
      logLine(id, `T-1 MIN`);
      await pushover("Falta 1 minuto", `Evento ${id}\nEn 1 min entra el video: ${picked.name}`);
    });
  }

  ctx.jobs.push(...[jobPreview, jobOneMin].filter(Boolean));
  state.current = ctx;
  saveScheduledState();

  return {
    id,
    videoPicked: picked.name,
    previewStart,
    oneMinBefore,
    launch
  };
}

function cancelCurrent(reason = "user_cancel") {
  const ctx = state.current;
  if (!ctx) return false;
  for (const j of ctx.jobs) { try { j.cancel(); } catch {} }
  if (ctx._cancelPipeline) {
    ctx._cancelPipeline();
  } else {
    stopProc(ctx.procs.feeder);
    stopProc(ctx.procs.muxer);
  }
  logLine(ctx.id, `CANCELLED reason=${reason}`);
  pushover("Evento cancelado", `Evento ${ctx.id}\nMotivo: ${reason}`, 1);
  state.history.unshift({ id: ctx.id, cancelledAt: nowISO(), config: ctx.config });
  state.current = null;
  clearScheduledStateFile();
  return true;
}

// Heartbeat watchdog (si ffmpeg muere sin avisar o se queda colgado)
setInterval(async () => {
  const ctx = state.current;
  if (!ctx) return;
  const age = Date.now() - (ctx.lastHeartbeat || Date.now());
  // Si en 90s no hubo output y debería estar corriendo un proceso, avisar.
  const shouldHaveProc = ["preview", "main", "post"].includes(ctx.status);
  if (shouldHaveProc && age > 90_000) {
    ctx.lastHeartbeat = Date.now(); // throttle
    await pushover("⚠️ Posible problema", `Evento ${ctx.id}\nNo hay actividad FFmpeg en 90s (status=${ctx.status}). Revisa logs.`, 1);
  }
}, 30_000);

// ---------- UI ----------
app.get("/", (req, res) => {
  const corts = listCortinillas();
  const vids = listVideos();
  const latest = vids[0] || null;
  const now = new Date();
  const defaultHour = now.getHours();
  const defaultMinute = now.getMinutes();

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
  <meta name="theme-color" content="#0d1b2a"/>
  <title>Playout</title>
  <style>
    :root {
      --bg: #0d1b2a;
      --bg-card: #1b2838;
      --bg-input: #243447;
      --text: #e6edf3;
      --text-muted: #8b9cad;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --success: #22c55e;
      --success-hover: #16a34a;
      --danger: #ef4444;
      --danger-hover: #dc2626;
      --live: #ef4444;
      --radius: 12px;
      --radius-sm: 8px;
      --space: 16px;
      --space-sm: 12px;
      --touch: 48px;
      --shadow: 0 4px 24px rgba(0,0,0,.25);
    }
    *, *::before, *::after { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      margin: 0;
      padding: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-size: 16px;
      line-height: 1.5;
    }
    .wrap {
      max-width: 560px;
      margin: 0 auto;
      padding: var(--space);
      padding-bottom: max(var(--space), env(safe-area-inset-bottom));
    }
    @media (min-width: 640px) {
      .wrap { max-width: 720px; padding: 24px; }
    }
    .header {
      padding: var(--space) 0;
      margin-bottom: var(--space);
      border-bottom: 1px solid rgba(255,255,255,.08);
    }
    .header h1 {
      margin: 0;
      font-size: 1.5rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .header p {
      margin: .35em 0 0;
      font-size: .875rem;
      color: var(--text-muted);
    }
    .card {
      background: var(--bg-card);
      border-radius: var(--radius);
      padding: var(--space);
      margin-bottom: var(--space);
      box-shadow: var(--shadow);
    }
    .card__title {
      margin: 0 0 var(--space-sm);
      font-size: 1rem;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    .card--status { border-left: 4px solid var(--accent); }
    .card--status.idle { border-left-color: var(--text-muted); }
    .card--status.live { border-left-color: var(--live); }
    .badge {
      display: inline-block;
      padding: 6px 12px;
      border-radius: 999px;
      font-size: .8125rem;
      font-weight: 600;
    }
    .badge--muted { background: rgba(255,255,255,.12); color: var(--text-muted); }
    .badge--info { background: rgba(59,130,246,.25); color: #93c5fd; }
    .badge--live { background: rgba(239,68,68,.25); color: #fca5a5; animation: pulse 1.5s ease-in-out infinite; }
    .badge--warn { background: rgba(234,179,8,.2); color: #fde047; }
    @keyframes pulse { 50% { opacity: .85; } }
    .meta {
      display: grid;
      gap: var(--space-sm);
      margin-top: var(--space);
    }
    .meta__row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 8px;
      align-items: baseline;
    }
    .meta__label { color: var(--text-muted); font-size: .875rem; }
    .meta__value { font-size: .875rem; word-break: break-all; }
    .meta__value code { background: var(--bg-input); padding: 2px 6px; border-radius: var(--radius-sm); font-size: .8125rem; }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: var(--touch);
      padding: 0 var(--space);
      font-size: 1rem;
      font-weight: 600;
      border: none;
      border-radius: var(--radius-sm);
      cursor: pointer;
      width: 100%;
      transition: background .15s, transform .1s;
    }
    .btn:active { transform: scale(0.98); }
    .btn--primary { background: var(--success); color: #fff; }
    .btn--primary:hover { background: var(--success-hover); }
    .btn--danger { background: var(--danger); color: #fff; margin-top: var(--space); }
    .btn--danger:hover { background: var(--danger-hover); }
    label {
      display: block;
      margin-bottom: 6px;
      font-size: .875rem;
      font-weight: 500;
      color: var(--text-muted);
    }
    input, select {
      width: 100%;
      min-height: var(--touch);
      padding: 0 var(--space-sm);
      margin-bottom: var(--space-sm);
      font-size: 16px;
      background: var(--bg-input);
      border: 1px solid rgba(255,255,255,.1);
      border-radius: var(--radius-sm);
      color: var(--text);
    }
    input:focus, select:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(59,130,246,.2);
    }
    select { cursor: pointer; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%238b9cad' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10l-5 5z'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 12px center; padding-right: 36px; }
    .row {
      display: grid;
      gap: var(--space-sm);
      grid-template-columns: 1fr 1fr;
    }
    .form-actions { margin-top: var(--space); }
    .stream-info {
      margin-top: var(--space-sm);
      padding: var(--space-sm);
      background: rgba(255,255,255,.06);
      border-radius: var(--radius-sm);
      font-size: .8125rem;
      color: var(--text-muted);
    }
    .stream-info code { font-size: .75rem; }
    .hint { margin-top: var(--space-sm); font-size: .8125rem; color: var(--text-muted); }
    .api-card .card__title { margin-bottom: 6px; }
    .api-card code { background: var(--bg-input); padding: 4px 8px; border-radius: var(--radius-sm); font-size: .875rem; }
    .api-link {
      display: inline-flex;
      align-items: center;
      min-height: var(--touch);
      padding: 0 var(--space);
      color: var(--accent);
      text-decoration: none;
      font-weight: 500;
      border-radius: var(--radius-sm);
      transition: background .15s;
    }
    .api-link:hover { background: rgba(59,130,246,.15); }
    .row-time { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-sm); }
    /* --- Live dashboard --- */
    .prog { height:6px; background:rgba(255,255,255,.1); border-radius:3px; overflow:hidden; }
    .prog__bar { height:100%; border-radius:3px; transition:width .8s linear; }
    .phase-label { font-size:.8125rem; font-weight:600; }
    .kv-grid { display:grid; grid-template-columns:auto 1fr; gap:4px 12px; font-size:.875rem; margin-top:var(--space-sm); }
    .kv-grid dt { color:var(--text-muted); white-space:nowrap; }
    .kv-grid dd { margin:0; word-break:break-all; }
    .kv-grid dd code { background:var(--bg-input); padding:1px 6px; border-radius:var(--radius-sm); font-size:.8125rem; }
    .delay-ok  { color:#22c55e; }
    .delay-med { color:#eab308; }
    .delay-bad { color:#ef4444; }
    .countdown { font-variant-numeric:tabular-nums; }
    /* Videos list */
    .video-item { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 12px; background:var(--bg-input); border-radius:var(--radius-sm); margin-bottom:8px; }
    .video-item:last-child { margin-bottom:0; }
    .video-info { flex:1; min-width:0; }
    .video-name { font-size:.875rem; word-break:break-all; }
    .video-size { font-size:.75rem; color:var(--text-muted); margin-top:2px; }
    .video-size.large { color:var(--danger); font-weight:600; }
    .btn--small { min-height:36px; padding:0 12px; font-size:.8125rem; width:auto; }
    .btn--compress { background:var(--accent); color:#fff; }
    .btn--compress:hover { background:var(--accent-hover); }
    .btn--compress:disabled { background:var(--text-muted); cursor:not-allowed; opacity:.6; }
    .compress-status { margin-top:var(--space); padding:var(--space-sm); background:rgba(59,130,246,.15); border-radius:var(--radius-sm); border-left:3px solid var(--accent); }
    .compress-status.error { background:rgba(239,68,68,.15); border-left-color:var(--danger); }
    .compress-status.success { background:rgba(34,197,94,.15); border-left-color:var(--success); }
    .compress-prog { height:6px; background:rgba(255,255,255,.1); border-radius:3px; margin-top:8px; overflow:hidden; }
    .compress-prog__bar { height:100%; background:var(--accent); border-radius:3px; transition:width .5s; }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="header">
      <h1>Playout</h1>
      <p>Programa y controla tu stream</p>
    </header>

    <section id="status-card" class="card card--status idle">
      <h2 class="card__title">Estado</h2>
      <div id="live-status"><p style="margin:0;color:var(--text-muted)">Cargando...</p></div>
    </section>

    <section class="card" id="videos-card">
      <h2 class="card__title">Videos</h2>
      <div id="videos-list"><p style="margin:0;color:var(--text-muted)">Cargando...</p></div>
    </section>

    <section class="card">
      <h2 class="card__title">Programar evento</h2>
      <p class="meta__value" style="margin-bottom:var(--space);color:var(--text-muted);font-size:.875rem">Último video: ${latest ? `<strong style="color:var(--text)">${safeText(latest.name)}</strong>` : "<em>No hay video</em>"}</p>

      <form method="POST" action="/schedule">
        <p class="meta__label" style="margin-bottom:6px">Hora de lanzamiento (CDMX)</p>
        <p class="meta__value" style="margin:0 0 var(--space-sm);font-size:.875rem;color:var(--text-muted)">Hoy</p>
        <div class="row-time">
          <div>
            <label for="launchHour">Hora</label>
            <select id="launchHour" name="launchHour" required>
              ${Array.from({ length: 24 }, (_, i) => `<option value="${i}"${i === defaultHour ? " selected" : ""}>${String(i).padStart(2, "0")}:00</option>`).join("")}
            </select>
          </div>
          <div>
            <label for="launchMinute">Minutos</label>
            <select id="launchMinute" name="launchMinute" required>
              ${Array.from({length: 60}, (_, m) => `<option value="${m}"${m === defaultMinute ? " selected" : ""}>${String(m).padStart(2, "0")}</option>`).join("")}
            </select>
          </div>
        </div>

        <div class="row">
          <div>
            <label for="previewMinutes">Preview (min)</label>
            <input id="previewMinutes" name="previewMinutes" type="number" value="15" min="1" max="180" required />
          </div>
          <div>
            <label for="postMinutes">Post (min)</label>
            <input id="postMinutes" name="postMinutes" type="number" value="1" min="0" max="30" required />
          </div>
        </div>

        <label for="cortinillaName">Cortinilla</label>
        <select id="cortinillaName" name="cortinillaName" required>
          ${corts.map(c => `<option value="${safeText(c)}">${safeText(c)}</option>`).join("")}
        </select>

        <label for="videoName">Video a lanzar</label>
        <select id="videoName" name="videoName">
          ${vids.map(v => `<option value="${safeText(v.name)}"${latest && v.name===latest.name ? " selected" : ""}>${safeText(v.name)} (${Math.round(v.size/1024/1024)} MB)</option>`).join("")}
        </select>

        <label for="streamDest">Destino del stream</label>
        <select name="streamDest" id="streamDest">
          <option value="directo">Directo</option>
          <option value="fb">Facebook</option>
        </select>

        <div id="fbKeyWrap" style="display:none">
          <label for="streamKey">Clave de transmisión (Facebook)</label>
          <input name="streamKey" type="password" id="streamKey" placeholder="Pega la clave de FB" />
        </div>
        <p id="directoInfo" class="stream-info">Stream directo: <code>rtmp://104.214.54.242/exatv2/exatvonline2</code></p>

        <div class="form-actions">
          <button type="submit" class="btn btn--primary">Programar y empezar</button>
        </div>
        <p class="hint">Protege esta página con Cloudflare Access o Basic Auth.</p>
      </form>
    </section>

    <section class="card" id="speedtest-card">
      <h2 class="card__title">Internet</h2>
      <div id="speedtest-content">
        <button class="btn btn--small btn--compress" id="speedtest-btn" onclick="runSpeedtest()">Medir velocidad</button>
      </div>
    </section>

    <section class="card api-card">
      <h2 class="card__title">API</h2>
      <a href="/api/status" target="_blank" rel="noopener" class="api-link"><code>GET /api/status</code></a>
      <p class="hint" style="margin-top:8px">Abre en nueva pestaña el JSON de estado.</p>
    </section>
  </div>
  <script>
    (function(){
      var dest = document.getElementById('streamDest');
      var fbWrap = document.getElementById('fbKeyWrap');
      var directoInfo = document.getElementById('directoInfo');
      var keyInput = document.getElementById('streamKey');
      function toggle(){
        var isFb = dest.value === 'fb';
        fbWrap.style.display = isFb ? 'block' : 'none';
        directoInfo.style.display = isFb ? 'none' : 'block';
        if (!isFb) keyInput.removeAttribute('required'); else keyInput.setAttribute('required','required');
      }
      dest.addEventListener('change', toggle);
      toggle();
    })();

    /* --- Live status dashboard --- */
    (function(){
      var el = document.getElementById('live-status');
      var card = document.getElementById('status-card');
      if (!el) return;

      var labels = {scheduled:'Programado',preview:'Preview',main:'En vivo',post:'Post',finished:'Terminado'};
      var colors = {scheduled:'#8b9cad',preview:'#3b82f6',main:'#ef4444',post:'#eab308',finished:'#8b9cad'};
      var phases = {'CORT-PRE':'Cortinilla pre','VIDEO':'Video principal','CORT-POST':'Cortinilla post'};
      var badgeClass = {scheduled:'badge--muted',preview:'badge--info',main:'badge--live',post:'badge--warn',finished:'badge--muted'};

      function pad(n){ return String(Math.floor(n)).padStart(2,'0'); }
      function fmtSec(s){
        if(s<0)s=0; var h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=Math.floor(s%60);
        return h>0 ? h+':'+pad(m)+':'+pad(sec) : pad(m)+':'+pad(sec);
      }
      function fmtDur(s){
        var h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=Math.round(s%60);
        return h>0 ? h+'h'+pad(m)+'m' : m+'m'+pad(sec)+'s';
      }
      function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

      function render(data){
        if(!data||!data.current){
          card.className='card card--status idle';
          var ih='<p style="margin:0;color:var(--text-muted)">Sin evento activo. Programa uno abajo.</p>';
          if(data&&data.temp!=null){
            var tc2=data.temp<65?'delay-ok':data.temp<80?'delay-med':'delay-bad';
            ih+='<p style="margin:.5em 0 0;font-size:.9em" class="'+tc2+'">Temp CPU: '+data.temp.toFixed(1)+'°C</p>';
          }
          el.innerHTML=ih;
          return;
        }
        var c=data.current, l=c.live||{}, s=c.status;
        var running=['preview','main','post'].indexOf(s)>=0;
        card.className='card card--status'+(s==='main'?' live':'');

        var h='';
        // Badge row
        h+='<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">';
        h+='<span class="badge '+(badgeClass[s]||'badge--muted')+'">'+(labels[s]||s)+'</span>';
        if(s==='main') h+='<span style="font-size:.75rem;color:#ef4444;font-weight:700">LIVE</span>';
        h+='</div>';

        // Progress (only when streaming)
        if(running && l.phase){
          var pct=l.feederDurSec>0 ? Math.min(100,l.ffmpegTimeSec/l.feederDurSec*100) : 0;
          var elapsed=l.ffmpegTimeSec||0;
          var remaining=Math.max(0,(l.feederDurSec||0)-elapsed);
          h+='<div style="margin-bottom:14px">';
          h+='<div style="display:flex;justify-content:space-between;margin-bottom:5px">';
          h+='<span class="phase-label">'+(phases[l.phase]||l.phase)+'</span>';
          h+='<span class="phase-label" style="color:var(--text-muted)">'+Math.round(pct)+'%</span>';
          h+='</div>';
          h+='<div class="prog"><div class="prog__bar" style="width:'+pct+'%;background:'+colors[s]+'"></div></div>';
          h+='<div style="display:flex;justify-content:space-between;margin-top:4px;font-size:.75rem;color:var(--text-muted)" class="countdown">';
          h+='<span>'+fmtSec(elapsed)+'</span>';
          h+='<span>-'+fmtSec(remaining)+'</span>';
          h+='</div>';
          h+='</div>';
        }

        // Info grid
        h+='<dl class="kv-grid">';
        h+='<dt>Video</dt><dd><code>'+esc(c.config.videoPicked)+'</code></dd>';
        if(l.videoDurSec) h+='<dt>Duración video</dt><dd>'+fmtDur(l.videoDurSec)+'</dd>';
        if(running && l.delaySec!=null){
          var dc=l.delaySec<5?'delay-ok':l.delaySec<15?'delay-med':'delay-bad';
          h+='<dt>Delay pipeline</dt><dd class="'+dc+'">'+l.delaySec.toFixed(1)+'s</dd>';
        }
        if(l.videoEndsAt){
          var vend=new Date(l.videoEndsAt);
          h+='<dt>Video termina</dt><dd style="font-weight:600;color:var(--accent)">'+pad(vend.getHours())+':'+pad(vend.getMinutes())+':'+pad(vend.getSeconds())+'</dd>';
        }
        if(l.estEndAt){
          var end=new Date(l.estEndAt);
          h+='<dt>Fin stream</dt><dd>'+pad(end.getHours())+':'+pad(end.getMinutes())+'</dd>';
        }
        if(running && l.pipelineStartedAt){
          var se=(Date.now()-l.pipelineStartedAt)/1000;
          h+='<dt>Stream total</dt><dd class="countdown">'+fmtSec(se)+'</dd>';
        }
        h+='<dt>Cortinilla</dt><dd><code>'+esc(c.config.cortinillaName)+'</code></dd>';
        h+='<dt>Lanzamiento</dt><dd>'+new Date(c.config.launchDateTime).toLocaleString('es-MX',{dateStyle:'short',timeStyle:'short'})+'</dd>';
        h+='<dt>Destino</dt><dd>'+(c.config.streamDest==='fb'?'Facebook':'Directo')+'</dd>';
        if(data.temp!=null){
          var tc2=data.temp<65?'delay-ok':data.temp<80?'delay-med':'delay-bad';
          h+='<dt>Temp CPU</dt><dd class="'+tc2+'">'+data.temp.toFixed(1)+'°C</dd>';
        }
        h+='</dl>';

        // Cancel button
        h+='<form method="POST" action="/cancel"><button type="submit" class="btn btn--danger">Cancelar evento</button></form>';
        el.innerHTML=h;
      }

      function poll(){
        fetch('/api/status').then(function(r){return r.json();}).then(render).catch(function(){});
      }
      poll();
      setInterval(poll, 2000);
    })();

    /* --- Videos management --- */
    (function(){
      var container = document.getElementById('videos-list');
      if (!container) return;

      function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

      function renderVideos(data){
        var videos = data.videos || [];
        var comp = data.compresion;
        var hist = data.historial || [];
        var h = '';

        // Compresión activa
        if (comp) {
          var isError = comp.status === 'error';
          h += '<div class="compress-status' + (isError ? ' error' : '') + '">';
          h += '<div style="display:flex;justify-content:space-between;align-items:center">';
          h += '<span style="font-weight:600">' + (isError ? 'Error' : 'Comprimiendo...') + '</span>';
          if (!isError) {
            h += '<span style="font-size:.875rem">' + comp.progress + '%</span>';
          }
          h += '</div>';
          h += '<div style="font-size:.8125rem;color:var(--text-muted);margin-top:4px">' + esc(comp.filename) + ' &rarr; ' + esc(comp.outputName) + '</div>';
          if (comp.profile) h += '<div style="font-size:.75rem;color:var(--text-muted);margin-top:2px">' + esc(comp.profile) + '</div>';
          if (!isError) {
            h += '<div class="compress-prog"><div class="compress-prog__bar" style="width:' + comp.progress + '%"></div></div>';
            h += '<button class="btn btn--small btn--danger" style="margin-top:10px" onclick="cancelarCompresion()">Cancelar</button>';
          } else {
            h += '<div style="color:var(--danger);font-size:.8125rem;margin-top:6px">' + esc(comp.error) + '</div>';
          }
          h += '</div>';
        }

        // Última compresión exitosa
        if (hist.length > 0 && !comp) {
          var last = hist[0];
          var sizeBefore = Math.round(last.sizeBefore / 1024 / 1024);
          var sizeAfter = Math.round(last.sizeAfter / 1024 / 1024);
          h += '<div class="compress-status success" style="margin-bottom:var(--space)">';
          h += '<div style="font-weight:600">Compresion completada</div>';
          h += '<div style="font-size:.8125rem;margin-top:4px">' + esc(last.outputName) + '</div>';
          h += '<div style="font-size:.8125rem;color:var(--text-muted)">' + sizeBefore + ' MB &rarr; ' + sizeAfter + ' MB (-' + last.reduction + '%)</div>';
          h += '</div>';
        }

        // Lista de videos
        if (videos.length === 0) {
          h += '<p style="margin:0;color:var(--text-muted)">No hay videos en la carpeta.</p>';
        } else {
          for (var i = 0; i < videos.length; i++) {
            var v = videos[i];
            h += '<div class="video-item">';
            h += '<div class="video-info">';
            h += '<div class="video-name">' + esc(v.name) + '</div>';
            h += '<div class="video-size' + (v.isLarge ? ' large' : '') + '">' + v.sizeMB + ' MB' + (v.isLarge ? ' (recomendado reducir)' : '') + (v.isProcessed ? ' (ya procesado)' : '') + '</div>';
            h += '</div>';
            h += '<div style="display:flex;gap:6px">';
          if (!v.isProcessed && !comp) {
            h += '<button class="btn btn--small btn--compress" onclick="mostrarOpciones(\\'' + esc(v.name).replace(/'/g,"\\\\'") + '\\')">Reducir</button>';
          } else if (!v.isProcessed && comp) {
            h += '<button class="btn btn--small btn--compress" disabled>Reducir</button>';
          }
          h += '<button class="btn btn--small" style="background:transparent;color:var(--danger);padding:0 8px" onclick="eliminarVideo(\\'' + esc(v.name).replace(/'/g,"\\\\'") + '\\')">&#128465;</button>';
          h += '</div>';
          h += '</div>';
          }
        }

        container.innerHTML = h;
      }

      window.mostrarOpciones = function(filename){
        var modal = document.createElement('div');
        modal.className = 'modal-compress';
        modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.8);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px';
        modal.innerHTML = '<div style="background:var(--bg-card);border-radius:var(--radius);padding:20px;max-width:340px;width:100%">' +
          '<h3 style="margin:0 0 16px;font-size:1rem">Reducir: ' + esc(filename) + '</h3>' +
          '<p style="margin:0 0 12px;font-size:.875rem;color:var(--text-muted)">Selecciona el nivel de compresion:</p>' +
          '<button class="btn btn--small" style="width:100%;margin-bottom:8px;background:var(--success)" onclick="reducirVideo(\\'' + esc(filename).replace(/'/g,"\\\\'") + '\\',\\'alta\\')">Alta calidad<br><span style=\\'font-weight:400;font-size:.75rem\\'>1080p, CRF 20 — ideal para venta</span></button>' +
          '<button class="btn btn--small" style="width:100%;margin-bottom:8px;background:var(--accent)" onclick="reducirVideo(\\'' + esc(filename).replace(/'/g,"\\\\'") + '\\',\\'balanceado\\')">Balanceado<br><span style=\\'font-weight:400;font-size:.75rem\\'>1080p, CRF 23 — streaming</span></button>' +
          '<button class="btn btn--small" style="width:100%;margin-bottom:12px;background:var(--text-muted)" onclick="reducirVideo(\\'' + esc(filename).replace(/'/g,"\\\\'") + '\\',\\'maximo\\')">Maxima compresion<br><span style=\\'font-weight:400;font-size:.75rem\\'>720p, CRF 28 — archivo pequeno</span></button>' +
          '<button class="btn btn--small btn--danger" style="width:100%" onclick="this.closest(\\'div\\').parentElement.remove()">Cancelar</button>' +
          '</div>';
        document.body.appendChild(modal);
        modal.addEventListener('click', function(e){ if(e.target===modal) modal.remove(); });
      };

      window.reducirVideo = function(filename, perfil){
        // Cerrar modal
        var modals = document.querySelectorAll('.modal-compress');
        modals.forEach(function(m){ m.remove(); });

        fetch('/api/reducir/' + encodeURIComponent(filename), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ perfil: perfil || 'balanceado' })
        })
          .then(function(r){ return r.json(); })
          .then(function(d){
            if (d.error) alert('Error: ' + d.error);
            pollVideos();
          })
          .catch(function(e){ alert('Error: ' + e); });
      };

      window.eliminarVideo = function(filename){
        if (!confirm('Eliminar "' + filename + '"?\\n\\nEsta accion no se puede deshacer.')) return;
        fetch('/api/videos/' + encodeURIComponent(filename), { method: 'DELETE' })
          .then(function(r){ return r.json(); })
          .then(function(d){
            if (d.error) alert('Error: ' + d.error);
            pollVideos();
          })
          .catch(function(e){ alert('Error: ' + e); });
      };

      window.cancelarCompresion = function(){
        if (!confirm('Cancelar compresion en curso?')) return;
        fetch('/api/reducir/cancelar', { method: 'POST' })
          .then(function(){ pollVideos(); })
          .catch(function(){});
      };

      function pollVideos(){
        fetch('/api/videos').then(function(r){ return r.json(); }).then(renderVideos).catch(function(){});
      }

      pollVideos();
      setInterval(pollVideos, 3000);
    })();

    /* --- Speedtest --- */
    (function(){
      var btn = document.getElementById('speedtest-btn');
      var container = document.getElementById('speedtest-content');
      if (!btn || !container) return;

      window.runSpeedtest = function(){
        btn.disabled = true;
        btn.textContent = 'Midiendo...';
        container.innerHTML = '<button class="btn btn--small btn--compress" disabled>Midiendo... (30-60s)</button>';

        fetch('/api/speedtest')
          .then(function(r){ return r.json(); })
          .then(function(d){
            if (d.error) {
              container.innerHTML = '<div style="color:var(--danger);font-size:.875rem">' + d.error + '</div>' +
                '<button class="btn btn--small btn--compress" style="margin-top:10px" onclick="runSpeedtest()">Reintentar</button>';
            } else {
              container.innerHTML = '<div class="kv-grid" style="margin:0">' +
                '<dt>Download</dt><dd><strong style="color:var(--success)">' + d.download + ' Mbps</strong></dd>' +
                '<dt>Upload</dt><dd><strong style="color:var(--accent)">' + d.upload + ' Mbps</strong></dd>' +
                '<dt>Ping</dt><dd>' + d.ping + ' ms</dd>' +
                '<dt>Servidor</dt><dd style="font-size:.75rem">' + d.server + '</dd>' +
                '</div>' +
                '<button class="btn btn--small btn--compress" style="margin-top:12px" onclick="runSpeedtest()">Medir de nuevo</button>';
            }
          })
          .catch(function(e){
            container.innerHTML = '<div style="color:var(--danger);font-size:.875rem">Error: ' + e + '</div>' +
              '<button class="btn btn--small btn--compress" style="margin-top:10px" onclick="runSpeedtest()">Reintentar</button>';
          });
      };

      // Verificar si está bloqueado por stream activo
      function checkSpeedtestStatus(){
        fetch('/api/speedtest/status')
          .then(function(r){ return r.json(); })
          .then(function(d){
            var btn = container.querySelector('button');
            if (btn && !d.running) {
              btn.disabled = d.blocked;
              if (d.blocked) btn.title = 'No disponible durante stream';
            }
          })
          .catch(function(){});
      }
      setInterval(checkSpeedtestStatus, 5000);
    })();
  </script>
</body>
</html>`);
});

app.post("/schedule", (req, res) => {
  try {
    const { launchDateTime: bodyDt, launchHour, launchMinute, cortinillaName, previewMinutes, postMinutes, streamDest, streamKey, videoName } = req.body;

    let launchDateTime;
    if (launchHour != null && launchMinute != null) {
      const now = new Date();
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, "0");
      const d = String(now.getDate()).padStart(2, "0");
      const h = String(Number(launchHour)).padStart(2, "0");
      const min = String(Number(launchMinute)).padStart(2, "0");
      launchDateTime = `${y}-${m}-${d}T${h}:${min}`;
    } else {
      launchDateTime = bodyDt;
    }

    let rtmpUrl;
    if (streamDest === "directo") {
      rtmpUrl = RTMP_DIRECTO;
    } else if (streamDest === "fb") {
      const key = String(streamKey || "").trim();
      if (!key) throw new Error("Clave de transmisión de Facebook obligatoria.");
      rtmpUrl = RTMP_FB_BASE + key;
    } else {
      rtmpUrl = req.body.rtmpUrl || DEFAULT_RTMP_URL;
    }

    scheduleEvent({
      launchDateTime,
      cortinillaName,
      previewMinutes: Number(previewMinutes),
      postMinutes: Number(postMinutes),
      rtmpUrl,
      videoName,
      streamDest
    });

    res.redirect("/");
  } catch (e) {
    res.status(400).send(String(e?.message || e));
  }
});

app.post("/cancel", (req, res) => {
  cancelCurrent("user_cancel");
  res.redirect("/");
});

function readPiTemp() {
  try {
    const r = spawnSync("vcgencmd", ["measure_temp"], { encoding: "utf8", timeout: 2000 });
    const m = (r.stdout || "").match(/([\d.]+)/);
    return m ? parseFloat(m[1]) : null;
  } catch { return null; }
}

app.get("/api/status", (req, res) => {
  const ctx = state.current;
  const l = ctx?.live;
  res.json({
    host: os.hostname(),
    temp: readPiTemp(),
    current: ctx ? {
      id: ctx.id,
      status: ctx.status,
      config: ctx.config,
      createdAt: ctx.createdAt,
      live: l ? {
        phase: l.phase,
        ffmpegTimeSec: l.ffmpegTimeSec,
        feederDurSec: l.feederDurSec,
        feederStartedAt: l.feederStartedAt,
        pipelineStartedAt: l.pipelineStartedAt,
        videoDurSec: l.videoDurSec,
        estEndAt: l.estEndAt,
        videoEndsAt: l.videoEndsAt,
        delaySec: l.delaySec,
        progress: l.feederDurSec > 0
          ? Math.min(100, +(l.ffmpegTimeSec / l.feederDurSec * 100).toFixed(1))
          : 0
      } : null
    } : null,
    history: state.history.slice(0, 10)
  });
});

// --- API de reducción de videos ---
app.get("/api/videos", (req, res) => {
  const processedSuffixes = /_(?:reducido|hq|min)\.mp4$/i;
  const videos = listVideos().map(v => ({
    name: v.name,
    sizeMB: Math.round(v.size / 1024 / 1024),
    sizeBytes: v.size,
    isLarge: v.size > 500 * 1024 * 1024,  // marcar en rojo (recomendado)
    isProcessed: processedSuffixes.test(v.name)  // ya fue comprimido
  }));
  res.json({ videos, compresion: compresionState.active, historial: compresionState.history.slice(0, 5) });
});

// Perfiles de compresión: calidad (CRF bajo = mejor calidad, archivo más grande)
const COMPRESS_PROFILES = {
  alta:      { crf: "20", preset: "medium", maxH: 1080, label: "Alta calidad (1080p, CRF 20)" },
  balanceado:{ crf: "23", preset: "medium", maxH: 1080, label: "Balanceado (1080p, CRF 23)" },
  maximo:    { crf: "28", preset: "faster", maxH: 720,  label: "Máxima compresión (720p, CRF 28)" }
};

app.post("/api/reducir/:filename", async (req, res) => {
  const filename = req.params.filename;
  const profileKey = req.body.perfil || "balanceado";
  const profile = COMPRESS_PROFILES[profileKey] || COMPRESS_PROFILES.balanceado;

  if (compresionState.active) {
    return res.status(409).json({ error: "Ya hay una compresión en curso", active: compresionState.active.filename });
  }

  const videoPath = path.join(VIDEOS_DIR, filename);
  if (!fs.existsSync(videoPath)) {
    return res.status(404).json({ error: "Video no encontrado" });
  }

  const stats = fs.statSync(videoPath);
  const ext = path.extname(filename);
  const baseName = path.basename(filename, ext);
  const suffix = profileKey === "alta" ? "_hq" : profileKey === "maximo" ? "_min" : "_reducido";
  const outputName = `${baseName}${suffix}.mp4`;
  const outputPath = path.join(VIDEOS_DIR, outputName);

  // Obtener duración para calcular progreso
  let duration = 0;
  try {
    const probe = await probeVideo(videoPath);
    duration = probe.duration || 0;
  } catch (e) {
    console.log(`[REDUCIR] No se pudo obtener duración de ${filename}: ${e?.message}`);
  }

  compresionState.active = {
    filename,
    outputName,
    profile: profile.label,
    startedAt: Date.now(),
    progress: 0,
    status: "comprimiendo",
    sizeBefore: stats.size,
    sizeAfter: null,
    duration,
    error: null
  };

  // Calcular resolución máxima según perfil
  const maxH = profile.maxH || 720;
  const maxW = Math.round(maxH * 16 / 9); // 1920 para 1080, 1280 para 720

  // FFmpeg args con perfil seleccionado
  const args = [
    "-y",
    "-i", videoPath,
    "-c:v", "libx264",
    "-preset", profile.preset,
    "-crf", profile.crf,
    "-vf", `scale='min(${maxW},iw)':'min(${maxH},ih)':force_original_aspect_ratio=decrease,format=yuv420p`,
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    "-progress", "pipe:1",
    outputPath
  ];

  console.log(`[REDUCIR] Iniciando: ${filename} -> ${outputName}`);

  const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  compresionState.active.pid = ffmpeg.pid;

  // Bajar prioridad para no afectar streams
  try { os.setPriority(ffmpeg.pid, 15); } catch {}

  // Parsear progreso desde stdout (progress pipe)
  ffmpeg.stdout.on("data", (data) => {
    const lines = String(data).split("\n");
    for (const line of lines) {
      // out_time_ms=12345678 (microsegundos)
      const m = line.match(/out_time_ms=(\d+)/);
      if (m && duration > 0) {
        const currentSec = parseInt(m[1]) / 1_000_000;
        compresionState.active.progress = Math.min(99, Math.round((currentSec / duration) * 100));
      }
    }
  });

  ffmpeg.stderr.on("data", (data) => {
    // Log errores pero no spam
    const s = String(data).trim();
    if (s.includes("error") || s.includes("Error")) {
      console.log(`[REDUCIR] ${s}`);
    }
  });

  ffmpeg.on("close", (code) => {
    if (code === 0 && fs.existsSync(outputPath)) {
      const outStats = fs.statSync(outputPath);
      const reduction = Math.round((1 - outStats.size / stats.size) * 100);
      console.log(`[REDUCIR] Completado: ${outputName} (${Math.round(outStats.size/1024/1024)}MB, -${reduction}%)`);

      compresionState.history.unshift({
        filename,
        outputName,
        sizeBefore: stats.size,
        sizeAfter: outStats.size,
        reduction,
        completedAt: Date.now()
      });
      if (compresionState.history.length > 5) compresionState.history.pop();

      compresionState.active = null;
    } else {
      console.log(`[REDUCIR] Falló: code=${code}`);
      if (compresionState.active) {
        compresionState.active.status = "error";
        compresionState.active.error = `FFmpeg terminó con código ${code}`;
        // Limpiar después de 30s
        setTimeout(() => {
          if (compresionState.active?.status === "error") {
            compresionState.active = null;
          }
        }, 30000);
      }
    }
  });

  ffmpeg.on("error", (err) => {
    console.log(`[REDUCIR] Error spawn: ${err?.message}`);
    if (compresionState.active) {
      compresionState.active.status = "error";
      compresionState.active.error = err?.message || "Error desconocido";
    }
  });

  res.json({ ok: true, mensaje: `Compresión iniciada: ${filename} -> ${outputName}` });
});

app.post("/api/reducir/cancelar", (req, res) => {
  if (!compresionState.active) {
    return res.status(400).json({ error: "No hay compresión activa" });
  }

  try {
    process.kill(compresionState.active.pid, "SIGTERM");
    console.log(`[REDUCIR] Cancelado por usuario: ${compresionState.active.filename}`);
    compresionState.active = null;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message });
  }
});

// --- Speedtest ---
let speedtestRunning = false;

app.get("/api/speedtest", (req, res) => {
  // No permitir si hay stream activo
  if (state.current && ["preview", "main", "post"].includes(state.current.status)) {
    return res.status(409).json({ error: "No se puede ejecutar durante un stream activo" });
  }

  if (speedtestRunning) {
    return res.status(409).json({ error: "Ya hay un test en curso" });
  }

  speedtestRunning = true;
  console.log("[SPEEDTEST] Iniciando...");

  const speedtest = spawn("speedtest-cli", ["--json"], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errorOutput = "";

  speedtest.stdout.on("data", (d) => { output += d; });
  speedtest.stderr.on("data", (d) => { errorOutput += d; });

  speedtest.on("close", (code) => {
    speedtestRunning = false;
    if (code !== 0) {
      console.log(`[SPEEDTEST] Error: ${errorOutput}`);
      return res.status(500).json({ error: "Speedtest falló", details: errorOutput });
    }

    try {
      const data = JSON.parse(output);
      const result = {
        download: (data.download / 1_000_000).toFixed(2), // Mbps
        upload: (data.upload / 1_000_000).toFixed(2),     // Mbps
        ping: data.ping.toFixed(1),                        // ms
        server: data.server?.sponsor || "Desconocido"
      };
      console.log(`[SPEEDTEST] OK: ${result.download} Mbps down, ${result.upload} Mbps up, ${result.ping}ms`);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: "Error parseando resultado", details: e?.message });
    }
  });

  speedtest.on("error", (err) => {
    speedtestRunning = false;
    res.status(500).json({ error: "No se pudo ejecutar speedtest-cli", details: err?.message });
  });
});

app.get("/api/speedtest/status", (req, res) => {
  const streamActive = state.current && ["preview", "main", "post"].includes(state.current.status);
  res.json({ running: speedtestRunning, blocked: streamActive });
});

app.delete("/api/videos/:filename", (req, res) => {
  const filename = req.params.filename;
  const videoPath = path.join(VIDEOS_DIR, filename);

  // Seguridad: verificar que el archivo está dentro de VIDEOS_DIR
  const realPath = path.resolve(videoPath);
  const realVideosDir = path.resolve(VIDEOS_DIR);
  if (!realPath.startsWith(realVideosDir)) {
    return res.status(403).json({ error: "Acceso denegado" });
  }

  if (!fs.existsSync(videoPath)) {
    return res.status(404).json({ error: "Video no encontrado" });
  }

  // No permitir eliminar si está en compresión
  if (compresionState.active && (compresionState.active.filename === filename || compresionState.active.outputName === filename)) {
    return res.status(409).json({ error: "No se puede eliminar, está en proceso de compresión" });
  }

  try {
    fs.unlinkSync(videoPath);
    console.log(`[VIDEOS] Eliminado: ${filename}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message });
  }
});

function restoreScheduledIfAny() {
  const data = loadScheduledState();
  if (!data) return;
  const c = data.config;
  let rtmpUrl = c.streamDest === "directo" ? RTMP_DIRECTO : DEFAULT_RTMP_URL;
  if (!validateRtmpUrl(rtmpUrl)) {
    console.error("Restore: RTMP no configurado (Facebook requiere RTMP_URL en .env). Evento no restaurado.");
    clearScheduledStateFile();
    return;
  }
  try {
    scheduleEvent({
      launchDateTime: c.launchDateTime,
      cortinillaName: c.cortinillaName,
      previewMinutes: c.previewMinutes,
      postMinutes: c.postMinutes,
      rtmpUrl,
      videoName: c.videoPicked,
      streamDest: c.streamDest
    }, { restoreId: data.id });
    console.log("Evento restaurado tras reinicio:", data.id);
    pushover("Evento restaurado", `Tras reinicio del servicio se re-programó el evento ${data.id}.`);
  } catch (e) {
    console.error("Restore falló:", e?.message);
    clearScheduledStateFile();
  }
}

restoreScheduledIfAny();

app.listen(PORT, () => {
  console.log(`Playout listo en http://localhost:${PORT}`);
  console.log(`Encoder: ${VIDEO_ENCODER}${USE_HW ? " (HW)" : " (SW)"} | ${OUT_WIDTH}x${OUT_HEIGHT}@${OUT_FPS}fps | ${VIDEO_BITRATE} video ${AUDIO_BITRATE} audio | threads=${THREADS}`);
});
