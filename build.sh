#!/bin/sh
# Dijalankan Netlify saat build. Jika KP_API_URL diset, config.js dibuat otomatis.
if [ -n "$KP_API_URL" ]; then
  printf "window.KP_CONFIG = { API: '%s' };\n" "$KP_API_URL" > web/js/config.js
  echo "config.js dibuat dari KP_API_URL"
else
  echo "KP_API_URL tidak diset, memakai web/js/config.js apa adanya"
fi
