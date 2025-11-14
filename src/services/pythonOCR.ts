import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';

export type PyOcrResult = {
  tipo_documento?: string;
  proveedor?: string;
  ruc_proveedor?: string;
  fecha_emision?: string;
  monto_total?: string | number;
  moneda?: string;
  categoria_gasto?: string;
  numero_documento?: string;
  items?: Array<{ descripcion: string; cantidad?: string | number; precio_unitario?: string | number; subtotal?: string | number }>;
  observaciones?: string;
  text?: string;
} | null;

export async function runPythonOCR(app: FastifyInstance, buffer: Buffer, mimeType: string): Promise<PyOcrResult> {
  try {
    const uploadsDir = path.join(process.cwd(), 'uploads');
    const tmpDir = path.join(uploadsDir, 'tmp');
    await fs.mkdir(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `ocr_${Date.now()}.png`);

    // Convert to high-quality PNG for OCR
    const png = await sharp(buffer)
      .rotate()
      .greyscale()
      .normalize()
      .resize({ width: 2200, withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer();
    await fs.writeFile(tmpFile, png);

    // Spawn python script
    const pyPath = path.join(process.cwd(), 'python', 'extract_expense.py');
    const isWin = process.platform === 'win32';
    const pythonEnv = process.env.PYTHON_CMD?.trim();
    const defaultVenv = path.join(
      process.cwd(),
      'python',
      '.venv',
      isWin ? 'Scripts' : 'bin',
      isWin ? 'python.exe' : 'python'
    );
    let pythonCmd: string;
    if (pythonEnv) {
      if (pythonEnv === 'python' || pythonEnv === 'python3' || pythonEnv === 'py') {
        pythonCmd = pythonEnv;
      } else {
        const candidate = path.isAbsolute(pythonEnv) ? pythonEnv : path.join(process.cwd(), pythonEnv);
        try {
          await fs.access(candidate);
          pythonCmd = candidate;
        } catch {
          // Si el candidato no existe (p.ej. ruta de Docker /app/...), usar venv por defecto local
          pythonCmd = defaultVenv;
          try { await fs.access(pythonCmd); } catch { pythonCmd = isWin ? 'py' : 'python'; }
        }
      }
    } else {
      pythonCmd = defaultVenv;
      try { await fs.access(pythonCmd); } catch { pythonCmd = isWin ? 'py' : 'python'; }
    }
    app.log.info({ msg: 'python ocr: resolved command', pythonCmd });
    const child = spawn(pythonCmd, [pyPath, tmpFile], { stdio: ['ignore', 'pipe', 'pipe'], cwd: process.cwd() });

    const chunks: Buffer[] = [];
    const errs: Buffer[] = [];
    child.stdout.on('data', (d) => chunks.push(Buffer.from(d)));
    child.stderr.on('data', (d) => errs.push(Buffer.from(d)));

    const exitCode: number = await new Promise((resolve) => {
      child.on('close', (code) => resolve(typeof code === 'number' ? code : -1));
      child.on('error', () => resolve(-1));
    });
    const out = Buffer.concat(chunks).toString('utf8').trim();
    const err = Buffer.concat(errs).toString('utf8').trim();

    // Cleanup
    fs.unlink(tmpFile).catch(() => {});

    if (exitCode !== 0) {
      app.log.warn({ msg: 'python ocr exit non-zero', exitCode, err });
      return null;
    }
    try {
      const parsed = JSON.parse(out);
      return parsed as PyOcrResult;
    } catch (e) {
      app.log.warn({ msg: 'python ocr parse error', out, err });
      return null;
    }
  } catch (e) {
    app.log.warn({ msg: 'python ocr error', error: String(e) });
    return null;
  }
}