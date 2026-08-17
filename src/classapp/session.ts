import fs from "node:fs/promises";
import path from "node:path";
import puppeteer, { type HTTPResponse } from "puppeteer-core";
import type { SessionData } from "../types.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const PROFILE_DIR = path.join(DATA_DIR, "chrome-profile");
const SESSION_FILE = path.join(DATA_DIR, "session.json");
const CLASSAPP_BASE_URL = process.env.CLASSAPP_BASE_URL || "https://classapp.com.br";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos para completar o login manual
const POLL_INTERVAL_MS = 1000;

/**
 * Abre um Chromium visível via Xvfb/noVNC (DISPLAY=:99) com perfil persistente
 * e aguarda o usuário logar manualmente (email/senha + eventual código de
 * confirmação por email). Detecta o login automaticamente: escuta todas as
 * respostas de rede da página e procura por accessToken/refreshToken em
 * qualquer resposta GraphQL — funciona tanto para login direto
 * (passwordAuthenticate) quanto para o fluxo com OTP, sem depender do nome
 * exato da mutation usada, e sem exigir nenhuma ação no terminal.
 *
 * Acesse http://localhost:6080 (ou a porta configurada em NOVNC_PORT) para
 * ver e controlar este navegador durante o login.
 */
export async function login(): Promise<void> {
  await fs.mkdir(PROFILE_DIR, { recursive: true });

  console.log(`Abrindo navegador. Acesse http://localhost:${process.env.NOVNC_PORT || 6080} para logar.`);

  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
    headless: false,
    userDataDir: PROFILE_DIR,
    args: ["--no-sandbox", "--start-maximized"],
  });

  const page = await browser.newPage();

  let captured: { accessToken: string; refreshToken?: string; clientId: string } | null = null;

  page.on("response", (response: HTTPResponse) => {
    void handleResponse(response).then((result) => {
      if (result) captured = result;
    });
  });

  await page.goto(CLASSAPP_BASE_URL, { waitUntil: "networkidle2" });

  console.log("Aguardando login manual (email/senha + código de confirmação, se solicitado)...");
  console.log("O token será capturado automaticamente assim que o login for concluído.");

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (!captured && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
  }

  if (!captured) {
    await browser.close();
    throw new Error(
      `Login não detectado em ${LOGIN_TIMEOUT_MS / 60000} minutos. Rode \`npm run login\` novamente.`
    );
  }

  const result = captured as { accessToken: string; refreshToken?: string; clientId: string };
  const session: SessionData = { capturedAt: new Date().toISOString(), ...result };
  await fs.writeFile(SESSION_FILE, JSON.stringify(session, null, 2));

  console.log(`Login detectado. Sessão salva em ${SESSION_FILE}.`);
  await browser.close();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleResponse(
  response: HTTPResponse
): Promise<{ accessToken: string; refreshToken?: string; clientId: string } | null> {
  const request = response.request();
  if (request.method() !== "POST" || !request.url().includes("/graphql")) return null;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }

  const accessToken = findFirstString(body, "accessToken");
  if (!accessToken) return null;

  const refreshToken = findFirstString(body, "refreshToken") ?? undefined;
  const clientId = new URL(request.url()).searchParams.get("client_id") ?? "";

  return { accessToken, refreshToken, clientId };
}

/** Busca recursivamente a primeira string associada à chave `key` em um objeto JSON arbitrário. */
function findFirstString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === key && typeof v === "string") return v;
    if (v && typeof v === "object") {
      const nested = findFirstString(v, key);
      if (nested) return nested;
    }
  }
  return null;
}

/** Carrega a sessão salva para uso no classapp/client.ts. Lança erro se ausente. */
export async function loadSession(): Promise<SessionData> {
  try {
    const raw = await fs.readFile(SESSION_FILE, "utf-8");
    return JSON.parse(raw) as SessionData;
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      throw new Error("Nenhuma sessão do ClassApp encontrada. Rode `npm run login` primeiro.");
    }
    throw err;
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
