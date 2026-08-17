import { exiftool } from "exiftool-vendored";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Recebe um Buffer de imagem e a data da mensagem do ClassApp (sem hora),
 * grava a imagem em um arquivo temporário com o EXIF ajustado para
 * meio-dia (12:00, horário local) dessa data, e retorna o path do arquivo
 * temporário resultante (o chamador é responsável por apagá-lo depois).
 */
export async function stampBufferAtNoon(
  buffer: Buffer,
  messageDate: string | Date,
  filenameHint = "photo.jpg"
): Promise<string> {
  const tmpPath = path.join(os.tmpdir(), `classapp-${Date.now()}-${filenameHint}`);
  await fs.writeFile(tmpPath, buffer);

  const noon = formatAtNoon(messageDate);

  await exiftool.write(tmpPath, {
    DateTimeOriginal: noon,
    CreateDate: noon,
  });

  return tmpPath;
}

/** Formata a data no padrão EXIF ("YYYY:MM:DD 12:00:00"), fixando o horário ao meio-dia local. */
function formatAtNoon(date: string | Date): string {
  const d = new Date(date);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}:${mm}:${dd} 12:00:00`;
}

export async function closeExifTool(): Promise<void> {
  await exiftool.end();
}
