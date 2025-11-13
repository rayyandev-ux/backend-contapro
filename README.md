# ContaPRO Backend

Servidor backend en Node.js con Fastify, PostgreSQL (Prisma), autenticación segura y OpenAI.

## Requisitos
- Node.js 20+
- Docker (para Postgres) o Postgres local

## Configuración
1. Copia `.env.example` a `.env` y rellena:
   - `DATABASE_URL`
   - `OPENAI_API_KEY`
   - `JWT_SECRET`
2. Levanta Postgres con Docker:
   ```bash
   docker compose up -d
   ```
3. Instala dependencias y genera Prisma:
   ```bash
   npm i
   npx prisma generate
   npm run prisma:migrate
   ```
4. Arranca en desarrollo:
   ```bash
   npm run dev
   ```

## Endpoints
- `POST /api/auth/register` – registra usuario y setea cookie `session`
- `POST /api/auth/login` – login y cookie `session`
- `POST /api/auth/logout` – limpia cookie
- `GET /api/auth/me` – usuario actual
- `GET /api/history` – historial del usuario (documentos y análisis)
- `POST /api/upload` – subir documento (multipart) y crear análisis vía OpenAI
- `GET /health` – healthcheck
- `GET /metrics` – métricas Prometheus
- `GET /docs` – Swagger UI

## Pruebas
```bash
npm run test
```
Umbral de cobertura configurado al 90%.

## Despliegue
- CI GitHub Actions en `.github/workflows/backend-ci.yml`
- Se puede construir imagen Docker y desplegar en tu plataforma favorita.

## OCR en Python (opcional)
Para mejorar la detección en imágenes complejas, el backend puede usar un fallback de OCR en Python.

### Instalación
- Requisitos: Python 3.10+ (Windows/macOS/Linux)
- Instala dependencias:
  ```bash
  cd backend/python
  pip install -r requirements.txt
  ```
- (Opcional) Define el intérprete si no es `python`:
  - En `.env` agrega: `PYTHON_CMD=python3` (o la ruta a tu intérprete)

### Funcionamiento
- Al subir un documento, si el modelo de IA no extrae campos críticos (proveedor, fecha, total, número), el backend invoca `backend/python/extract_expense.py` y fusiona los datos de OCR.
- El script usa RapidOCR (ONNX) y heurísticas para fecha, total, moneda, RUC y número.

### Notas
- Si el OCR no está disponible, el sistema sigue funcionando usando únicamente OpenAI.
- El OCR escribe un PNG temporal en `uploads/tmp` y lo elimina al terminar.

## LLM en Python (OpenAI visión)
Puedes usar Python para invocar el modelo de OpenAI (gpt-4o / gpt-4o-mini) y extraer el JSON estructurado.

### Instalación
- Requisitos: Python 3.10+ y `OPENAI_API_KEY` configurado en `.env`.
- Instala dependencias:
  ```bash
  cd backend/python
  pip install -r requirements.txt
  ```
- Activa el backend Python en `.env`:
  ```
  LLM_BACKEND=python
  PYTHON_CMD=python  # o python3
  OPENAI_MODEL=gpt-4o  # o gpt-4o-mini
  ```

### Funcionamiento
- Al subir un documento, si `LLM_BACKEND=python`, el backend invoca `backend/python/llm_extract.py`, que usa el prompt en español con `response_format` de JSON schema y devuelve un JSON estricto.
- Si hay fallo en Python o el JSON carece de campos críticos, se aplica el fallback de OCR para rellenar lo que falte.

### Conmutación rápida
- Para volver al cliente Node, cambia `LLM_BACKEND` a cualquier valor distinto de `python`.