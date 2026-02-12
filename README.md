# Playout Raspberry (a prueba de todo)
Sistema de "playout" para Raspberry Pi: seleccionas **cortinilla**, **video**, **hora de lanzamiento**, **minutos de preview** y **minutos post**.
El Pi envía:
1) Cortinilla en loop durante preview
2) Video principal
3) Cortinilla final por N minutos
y manda notificaciones por **Pushover**:
- Preview inició
- Falta 1 min
- Video inició
- Video terminó
- Transmisión terminada
- **Cualquier falla** (FFmpeg se cae / error / archivo faltante / etc.)

## Requisitos
- Raspberry Pi OS / Debian
- `ffmpeg` instalado
- Node.js 18+ (recomendado 20)
- (Opcional) PM2 para dejarlo corriendo

## Instalación
```bash
sudo apt update
sudo apt install -y ffmpeg curl
# Node.js (si no tienes): instala Node 20 con NodeSource o similar

cd ~
unzip playout.zip -d playout
cd playout
npm install
cp .env.example .env
nano .env   # pon tu RTMP_URL y pushover
```

## Carpetas
- `cortinillas/`  -> exa.mp4, noticias.mp4, etc (nombres fijos)
- `videos/`       -> aquí cae el video (cualquier nombre)
- `logs/`         -> logs por evento

## Ejecutar
```bash
npm start
# abre http://localhost:8080 en el navegador del Pi
```

## Dejarlo corriendo (PM2)
```bash
sudo npm i -g pm2
pm2 start server.js --name playout
pm2 save
pm2 startup
```

## Exponerlo por Nginx + Cloudflare (RECOMENDADO con auth)
NO lo expongas público sin protección. Mínimo:
- Cloudflare Access (Zero Trust) o
- Basic Auth en Nginx

Ejemplo Nginx (solo referencia):
```
location / {
  auth_basic "Restricted";
  auth_basic_user_file /etc/nginx/.htpasswd;
  proxy_pass http://127.0.0.1:8080;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

## Stream key en el HTML (seguridad)
La UI permite pegar el RTMP URL completo (incluye key). **Se guarda SOLO en memoria** para el evento actual y NO se imprime en la UI ni se escribe a disco.
Aun así, si lo expones público, protege el acceso.

## A prueba de todo (transcoding)
Este sistema **re-encodea siempre** a un perfil estable:
- H.264 + AAC
- 1080p30 (ajustable en .env)
- GOP fijo
Esto evita que al cambiar entre cortinilla/video se corte el RTMP por codecs distintos.

## Logs
`logs/evt_*.log`
