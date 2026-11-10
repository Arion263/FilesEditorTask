# Constraints y Limitaciones de la Implementación Actual

Este documento detalla las restricciones arquitectónicas y técnicas asociadas a la plataforma de despliegue seleccionada (Vercel Serverless Functions) y al procesamiento de archivos en el navegador.

---

## 1. Límite de Tamaño de Archivo (Upload Payload Ceiling: 4 MB)

### El Problema
- **Restricción de infraestructura en Vercel:** Las funciones serverless de Vercel (tanto en tiers gratuitos como de pago estándar) aplican un límite estricto de **4.5 MB** en el cuerpo de las solicitudes HTTP entrantes (`request body payload`).
- Si un cliente intenta enviar una petición `multipart/form-data` con un archivo superior a este límite directamente hacia la ruta de la API (`/api/documents/import` o `/api/convert`), el proxy de borde de Vercel aborta la conexión inmediatamente y devuelve un error **`413 FUNCTION_PAYLOAD_TOO_LARGE`**, sin permitir que la función de Python se ejecute ni emita un mensaje de error controlado.
- **Configuración adoptada:** Para mantenerse dentro de los márgenes seguros de transporte HTTP y metadata de la solicitud, el límite de subida directa se estableció en **4 MB**.

### Impacto en el Producto
- Archivos `.docx` de gran tamaño que contengan imágenes de alta resolución incrustadas o manuales extensos podrían superar los 4 MB y ser rechazados por el validador cliente/servidor.

---

## 2. Persistencia en Funciones Serverless (Filesystem Efímero)

### El Problema
- En entornos serverless, el sistema de archivos raíz es de **solo lectura** (con excepción del directorio temporal `/tmp`).
- El directorio `/tmp` se destruye y reinicia periódicamente en cada "cold restart" o nuevo despliegue, además de estar completamente aislado entre distintas instancias concurrentes de la función.
- Por esta razón, una base de datos local SQLite en el filesystem de la función no garantiza durabilidad en producción, requiriendo un backend PostgreSQL administrado externo (como Neon o Supabase).

---

## 3. Renderizado y Rendimiento en el Editor (DOM / TipTap)

### El Problema
- La aplicación convierte el contenido de los documentos en HTML para ser editado en TipTap (ProseMirror).
- Un archivo de texto plano o Markdown de 4 MB equivale aproximadamente a entre **700,000 y 800,000 palabras** (más de 1,500 páginas de texto plano).
- Renderizar e interactuar en tiempo real con árboles de nodos DOM de semejante magnitud dentro de un navegador puede provocar degradación en la tasa de refresco (framerate) o bloqueos temporales en la pestaña del navegador.

---

## Solución Futura y Escalabilidad

Para superar estas limitaciones en etapas posteriores, las soluciones arquitectónicas recomendadas son:

1. **Subida Directa a Almacenamiento de Objetos (Pre-signed Upload / Direct to Bucket):**
   - El cliente solicita a la API una URL pre-firmada (`pre-signed URL`) de corta duración.
   - El navegador sube el archivo directamente a un bucket de almacenamiento externo (como **Cloudflare R2**, **AWS S3** o **Vercel Blob**), saltándose por completo el proxy serverless de Vercel.
   - Una vez cargado el archivo, la API o un worker en background descarga y procesa el archivo desde el bucket sin estar atado a la restricción de 4.5 MB de payload HTTP.

2. **Migración a Infraestructura Dedicada o de Pago:**
   - Desplegar el backend Python en un contenedor o servicio de ejecución persistente (como **Railway**, **Render**, **Fly.io** o **Google Cloud Run**), donde los límites de payload del servidor web (Gunicorn / Nginx / Uvicorn) pueden configurarse libremente en 20 MB, 50 MB o más.

> **Nota:** Estas soluciones no son estrictamente necesarias para el alcance actual del proyecto, ya que la subida directa de 4 MB cubre ampliamente los requisitos funcionales evaluados para documentos de texto y formato rico (`.txt`, `.md`, `.docx`).
