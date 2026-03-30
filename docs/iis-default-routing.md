# Despliegue directo de Node en `http://host/` (sin IIS)

Este proyecto ya no requiere IIS como reverse proxy para exponer el login/panel.
La API unificada (`api/app.js`) puede publicarse directamente en puerto 80.

## Comportamiento de red

- Puerto por defecto: `80`
- Override: variable de entorno `PORT`
- Healthcheck: `GET /health`
- Login/panel: `GET /`

## Arranque recomendado

```bash
npm install
npm run start:api
```

Con eso, la aplicación queda disponible en `http://host/`.

## Usar otro puerto (compatibilidad)

```bash
PORT=8080 npm run start:api
```

Esto mantiene compatibilidad para ambientes donde no sea posible usar `80`.

## Verificación rápida

1. Confirmar proceso Node levantado.
2. Validar healthcheck:
   ```bash
   curl http://127.0.0.1/health
   ```
3. Abrir `http://host/` y validar login + navegación del panel.

## Consideraciones para Windows (servicio persistente)

Si necesitás arranque automático y ejecución en segundo plano en Windows:

1. Crear un servicio para Node (por ejemplo con NSSM o WinSW) que ejecute `npm run start:api`.
2. Configurar variables de entorno del servicio (`PORT`, `PANEL_USER`, `PANEL_PASS`, etc.).
3. Definir carpeta de trabajo del servicio en la raíz del repositorio.
4. Habilitar recuperación automática del servicio ante fallos.
5. Abrir firewall para el puerto publicado (80 u otro definido en `PORT`).

> Nota: en despliegue directo, ya no aplican configuraciones de URL Rewrite/ARR de IIS para enrutar al panel.
