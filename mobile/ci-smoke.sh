#!/bin/bash
# Проверка APK в эмуляторе Android (CI): ставим, запускаем, ждём, снимаем экраны и журнал ошибок.
set -x
APK="$1"; OUT="${2:-smoke}"; mkdir -p "$OUT"
adb wait-for-device
adb shell settings put global window_animation_scale 0 || true
adb install -r "$APK" || { echo "НЕ УСТАНОВИЛОСЬ"; exit 1; }
adb logcat -c
WH=$(adb shell wm size | tail -1 | grep -oE "[0-9]+x[0-9]+"); SW=${WH%x*}; SH=${WH#*x}; echo "экран $SW x $SH"
X() { echo $(( SW * $1 / 100 )); }; Y() { echo $(( SH * $1 / 100 )); }
adb shell monkey -p ru.pulse.app -c android.intent.category.LAUNCHER 1
sleep 35
adb exec-out screencap -p > "$OUT/shot-1-start.png"
adb shell pidof ru.pulse.app > "$OUT/pid.txt" || echo "ПРОЦЕСС НЕ НАЙДЕН" > "$OUT/pid.txt"
# свайп вверх по главной — видно, что интерфейс живой
adb shell input swipe $(X 50) $(Y 75) $(X 50) $(Y 30) 300; sleep 4
adb exec-out screencap -p > "$OUT/shot-2-scroll.png"
sleep 20
adb exec-out screencap -p > "$OUT/shot-3-later.png"
# лучи сверху двигаются? два кадра с паузой
adb shell input swipe $(X 50) $(Y 30) $(X 50) $(Y 75) 300; sleep 3
adb exec-out screencap -p > "$OUT/shot-4-rays-a.png"; sleep 2
adb exec-out screencap -p > "$OUT/shot-5-rays-b.png"
# профиль (аватар слева вверху)
adb shell input tap $(X 14) $(Y 8); sleep 4
adb exec-out screencap -p > "$OUT/shot-6-profile.png"
adb shell input keyevent 4; sleep 3
# вкладка «Пульс»
adb shell input tap $(X 50) $(Y 94); sleep 5
adb exec-out screencap -p > "$OUT/shot-7-pulse.png"
adb logcat -d -v brief ReactNativeJS:V ReactNative:V AndroidRuntime:E Expo:V '*:E' > "$OUT/logcat.txt" || true
adb shell pidof ru.pulse.app && echo "ЖИВ" >> "$OUT/pid.txt" || echo "УПАЛ" >> "$OUT/pid.txt"
cat "$OUT/pid.txt"
grep -iE "FATAL|Error|Exception" "$OUT/logcat.txt" | head -60 || true
exit 0
