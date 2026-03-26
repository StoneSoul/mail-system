# IIS: redirigir `http://mailboard/` al login del tablero

Si al entrar a `http://192.168.14.4/` (o al hostname DNS, por ejemplo `http://mailboard/`) ves la página de bienvenida de IIS, significa que **IIS está respondiendo con su sitio por defecto** y tu app Node no está siendo publicada en esa ruta.

En este proyecto, el login del tablero se sirve desde `GET /` en la API (`api/app.js`), y el propio HTML decide si mostrar login o panel según sesión (`mvp/web/index.html`).

## Opción recomendada (IIS como reverse proxy hacia Node)

> Objetivo: que todo lo que llegue a `http://mailboard/` termine en tu app (por ejemplo Node escuchando en `http://127.0.0.1:3000`).

### 1) Prerrequisitos en IIS

1. Instalar módulo **URL Rewrite**.
2. Instalar y habilitar **Application Request Routing (ARR)**.
3. En ARR Server Proxy Settings, habilitar **Enable proxy**.

### 2) Binding del sitio

En IIS, en el sitio que publicará el tablero:

- Binding HTTP puerto `80`
- Host name: `mailboard` (o el nombre DNS que vayas a usar)

Y en DNS, crear el registro A/CNAME apuntando a `192.168.14.4`.

### 3) `web.config` para proxy

Crear `web.config` en la raíz del sitio IIS (no en la carpeta de logs) con una regla como esta:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="MailSystemReverseProxy" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="http://127.0.0.1:3000/{R:1}" appendQueryString="true" />
          <serverVariables>
            <set name="HTTP_X_FORWARDED_PROTO" value="http" />
            <set name="HTTP_X_FORWARDED_HOST" value="{HTTP_HOST}" />
          </serverVariables>
        </rule>
      </rules>
    </rewrite>
  </system.webServer>
</configuration>
```

Con esto, al abrir `http://mailboard/`, IIS entregará lo que responde Node en `/` (que en este proyecto es el login/panel).

---

## Opción rápida (solo redirección, sin proxy)

Si solo quieres salir de la home de IIS y mandar a otra URL, puedes usar **HTTP Redirect** en el sitio por defecto:

- Redirect requests to: `http://mailboard:3000/`
- Status code: `302` o `301`

⚠️ Esto expone el puerto `3000` al usuario final en la URL. Para producción es preferible reverse proxy.

---

## Checklist de verificación

1. `npm run start:api` levantado y escuchando en `3000`.
2. Desde el server: `curl http://127.0.0.1:3000/health` responde `ok:true`.
3. En IIS, revisar que el sitio correcto tenga binding `mailboard:80`.
4. Detener o quitar prioridad del **Default Web Site** si está capturando `*:80`.
5. Probar desde cliente: `http://mailboard/`.

Si sigue apareciendo el welcome de IIS, casi siempre es conflicto de bindings (sitio equivocado respondiendo en el 80).
