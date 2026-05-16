# EDIAN Backend

Backend para el sistema EDIAN de descarga y procesamiento de facturas electrónicas DIAN.

## Stack
- **Node.js 20** + Express
- **Playwright** (Chromium headless) para scraping del portal DIAN
- **xml2js** para parseo de XML UBL 2.1
- **xlsx** para generación de Excel
- **jszip** para manejo de ZIPs

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/api/dian/validar-token` | Valida el token URL de la DIAN |
| POST | `/api/dian/descargar` | Descarga + parsea XMLs del portal DIAN |
| POST | `/api/dian/excel-items` | Genera Excel detallado (1 fila por ítem) |
| POST | `/api/dian/excel-resumen` | Genera Excel igual al export de la DIAN |
| POST | `/api/fase2/procesar-xml` | Sube XMLs/ZIPs y los parsea (para pruebas) |

---

## Despliegue en Railway

### 1. Crear repositorio en GitHub

```bash
# En tu computador, crea la carpeta con estos archivos y ejecuta:
git init
git add .
git commit -m "EDIAN backend inicial"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/edian-backend.git
git push -u origin main
```

### 2. Crear proyecto en Railway

1. Ve a [railway.app](https://railway.app) → **New Project**
2. Elige **Deploy from GitHub repo**
3. Selecciona el repo `edian-backend`
4. Railway detecta el `Dockerfile` automáticamente

### 3. Variables de entorno en Railway

En el panel de Railway → tu servicio → **Variables**:

```
FRONTEND_URL=*
PORT=3001
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
```

### 4. Obtener la URL del backend

Railway asigna una URL tipo:
`https://edian-backend-production.up.railway.app`

Esa URL va en el frontend en la variable `BACKEND_URL`.

---

## Prueba local

```bash
npm install
node src/index.js
```

### Probar el parser XML con curl:
```bash
curl -X POST http://localhost:3001/api/fase2/procesar-xml \
  -F "archivos=@01_110124_1205_100271099.xml"
```

### Probar validación de token:
```bash
curl -X POST http://localhost:3001/api/dian/validar-token \
  -H "Content-Type: application/json" \
  -d '{"tokenUrl":"https://catalogo-vpfe.dian.gov.co/User/AuthToken?pk=10910094|1023923499&rk=901500560&token=d0f7fac2-6abd-4a1a-abbc-e2ae1edced12"}'
```

---

## Flujo completo

```
Frontend (app.html)
    │
    ├─ POST /api/dian/validar-token  → valida el URL del token
    │
    ├─ POST /api/dian/descargar      → Playwright entra al portal DIAN,
    │                                  descarga ZIPs, parsea XMLs,
    │                                  devuelve JSON con filas (1/ítem)
    │
    └─ POST /api/dian/excel-items    → genera y descarga el Excel detallado
```
