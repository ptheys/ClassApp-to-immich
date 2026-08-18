import axios, { type AxiosInstance } from "axios";
import FormData from "form-data";

const BASE_URL = process.env.IMMICH_BASE_URL;
const API_KEY = process.env.IMMICH_API_KEY;

interface ImmichTag {
  id: string;
  name: string;
  value: string;
}

function http(): AxiosInstance {
  if (!BASE_URL || !API_KEY) {
    throw new Error("IMMICH_BASE_URL e IMMICH_API_KEY precisam estar definidos no .env");
  }
  return axios.create({
    baseURL: BASE_URL,
    headers: { "x-api-key": API_KEY },
  });
}

const tagIdCache = new Map<string, string>();

/**
 * Garante que a tag exista no Immich e retorna seu id (com cache em memória).
 * `path` suporta tags em cascata usando "/" (ex: "ClassApp/Bárbara" cria/reaproveita
 * a tag pai "ClassApp" e a filha "Bárbara" abaixo dela).
 */
export async function ensureTag(path: string): Promise<string> {
  const cached = tagIdCache.get(path);
  if (cached) return cached;

  const client = http();
  const { data: tags } = await client.get<ImmichTag[]>("/tags");
  const existing = tags.find((t) => t.value === path);
  if (existing) {
    tagIdCache.set(path, existing.id);
    return existing.id;
  }

  const { data: created } = await client.post<ImmichTag>("/tags", { name: path });
  tagIdCache.set(path, created.id);
  return created.id;
}

export interface UploadAssetArgs {
  buffer: Buffer;
  filename: string;
  takenAt: Date;
  deviceAssetId: string;
}

/**
 * Envia um asset ao Immich. `deviceAssetId` deve ser estável e único
 * (usar o attachmentId do ClassApp) para permitir que o próprio Immich
 * detecte duplicatas em uploads repetidos, além do controle de estado local.
 */
export async function uploadAsset({ buffer, filename, takenAt, deviceAssetId }: UploadAssetArgs): Promise<string> {
  const client = http();

  const form = new FormData();
  form.append("assetData", buffer, filename);
  form.append("deviceAssetId", deviceAssetId);
  form.append("deviceId", "classapp-sync");
  form.append("fileCreatedAt", takenAt.toISOString());
  form.append("fileModifiedAt", takenAt.toISOString());

  const res = await client.post<{ id: string }>("/assets", form, {
    headers: form.getHeaders(),
    validateStatus: () => true,
  });

  if (res.status >= 400) {
    throw new Error(`Immich respondeu ${res.status} ao enviar ${filename}: ${JSON.stringify(res.data)}`);
  }

  return res.data.id;
}

export async function addTagToAsset(assetId: string, tagName: string): Promise<void> {
  const client = http();
  const tagId = await ensureTag(tagName);
  await client.put(`/tags/${tagId}/assets`, { ids: [assetId] });
}

export async function setAssetDescription(assetId: string, description: string): Promise<void> {
  const client = http();
  await client.put(`/assets/${assetId}`, { description });
}
