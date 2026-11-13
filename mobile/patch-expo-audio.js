// Доработки нативного плеера expo-audio для «Пульса» (применяются в CI перед сборкой APK):
//  1) «будильник» сети и процессора, пока играет музыка (WAKE_MODE_NETWORK) — при выключенном экране телефон
//     не засыпает между треками, и следующий трек включается;
//  2) кнопки «назад» и «вперёд» в шторке и на экране блокировки — нажатия уходят в приложение (событие remote);
//  3) пауза, когда отключили наушники.
// Если код expo-audio поменялся и замена не нашлась — сборка останавливается с понятной ошибкой.
const fs = require('fs'); const path = require('path');
const root = path.join(process.argv[2] || '.', 'node_modules/expo-audio/android/src/main/java/expo/modules/audio');
function edit(file, pairs) {
  const p = path.join(root, file); let t = fs.readFileSync(p, 'utf8');
  for (const [a, b] of pairs) { if (!t.includes(a)) throw new Error('patch-expo-audio: не нашёл в ' + file + ':\n' + a); t = t.replace(a, b); }
  fs.writeFileSync(p, t); console.log('patch-expo-audio:', file, 'ok');
}
edit('AudioPlayer.kt', [
  ['    .setAudioAttributes(AudioAttributes.DEFAULT, false)\n', '    .setAudioAttributes(AudioAttributes.DEFAULT, false)\n    .setWakeMode(C.WAKE_MODE_NETWORK)\n    .setHandleAudioBecomingNoisy(true)\n'],
  ['  fun setActiveForLockScreen(', `  // кнопка из шторки / экрана блокировки → в приложение (поле remote в статусе плеера)
  fun sendRemote(cmd: String) {
    playerScope.launch { sendPlayerUpdate(mapOf("remote" to cmd, "remoteAt" to System.currentTimeMillis().toDouble())) }
  }

  fun setActiveForLockScreen(`],
]);
edit('service/AudioControlsService.kt', [
  // кнопки «назад» / «вперёд» в сессии Media3 (Android 13+ рисует плеер по ним)
  ['    // Add play/pause button (always present)\n', `    customLayout.add(
      CommandButton.Builder(CommandButton.ICON_PREVIOUS)
        .setDisplayName("Previous")
        .setEnabled(true)
        .setSessionCommand(SessionCommand(ACTION_PREV, Bundle.EMPTY))
        .build()
    )
    // Add play/pause button (always present)
`],
  ['    session.setCustomLayout(customLayout)\n', `    customLayout.add(
      CommandButton.Builder(CommandButton.ICON_NEXT)
        .setDisplayName("Next")
        .setEnabled(true)
        .setSessionCommand(SessionCommand(ACTION_NEXT, Bundle.EMPTY))
        .build()
    )
    session.setCustomLayout(customLayout)
`],
  ['    const val ACTION_SEEK_FORWARD = ', '    const val ACTION_NEXT = "expo.modules.audio.action.NEXT"\n    const val ACTION_PREV = "expo.modules.audio.action.PREV"\n    const val ACTION_SEEK_FORWARD = '],
  ['      ACTION_TOGGLE -> withPlayerOnAppThread { player ->', '      ACTION_NEXT -> remote("next")\n      ACTION_PREV -> remote("prev")\n      ACTION_TOGGLE -> withPlayerOnAppThread { player ->'],
  ['import java.net.URL\n', 'import java.net.URL\nimport android.graphics.drawable.Icon\nimport android.media.MediaMetadata\nimport android.media.session.PlaybackState\nimport android.os.SystemClock\n'],
  // Своя «классическая» системная сессия плеера (android.media.session). Её понимают все оболочки — Huawei EMUI /
  // HarmonyOS, MIUI, старые Android: они берут из неё «что играет», позицию и кнопки. Сессия Media3 у этих оболочек
  // показывалась как «Не воспроизводится» и без кнопок.
  ['  private var playbackListener: Player.Listener? = null\n', `  private var playbackListener: Player.Listener? = null
  @Volatile private var lastPlaying = false
  @Volatile private var lastPos = 0L
  @Volatile private var lastDur = 0L
  private var fw: android.media.session.MediaSession? = null

  fun remote(cmd: String) { currentPlayer?.sendRemote(cmd) }

  @Synchronized private fun fwSession(): android.media.session.MediaSession {
    fw?.let { return it }
    val s = android.media.session.MediaSession(this, "PulsePlayer")
    s.setCallback(object : android.media.session.MediaSession.Callback() {
      override fun onPlay() { withPlayerOnAppThread { it.play() } }
      override fun onPause() { withPlayerOnAppThread { it.pause() } }
      override fun onStop() { withPlayerOnAppThread { it.pause() } }
      override fun onSkipToNext() { remote("next") }
      override fun onSkipToPrevious() { remote("prev") }
      override fun onSeekTo(pos: Long) { withPlayerOnAppThread { it.seekTo(pos) } }
    }, Handler(Looper.getMainLooper()))
    buildContentIntent()?.let { s.setSessionActivity(it) }
    s.isActive = true
    fw = s
    return s
  }

  // снимок состояния плеера (только из главного потока — там живёт плеер)
  private fun snap() {
    val p = currentPlayer?.ref ?: return
    lastPlaying = p.isPlaying
    lastPos = p.currentPosition.coerceAtLeast(0L)
    lastDur = if (p.duration > 0) p.duration else 0L
  }

  private fun updateFw() {
    val s = fwSession()
    val md = MediaMetadata.Builder()
      .putString(MediaMetadata.METADATA_KEY_TITLE, currentMetadata?.title ?: "")
      .putString(MediaMetadata.METADATA_KEY_ARTIST, currentMetadata?.artist ?: "")
      .putString(MediaMetadata.METADATA_KEY_ALBUM, currentMetadata?.albumTitle ?: "")
      .putLong(MediaMetadata.METADATA_KEY_DURATION, lastDur)
    currentArtwork?.let { md.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, it) }
    s.setMetadata(md.build())
    val actions = PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
      PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_SEEK_TO or PlaybackState.ACTION_STOP
    s.setPlaybackState(PlaybackState.Builder()
      .setActions(actions)
      .setState(if (lastPlaying) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED, lastPos, if (lastPlaying) 1f else 0f, SystemClock.elapsedRealtime())
      .build())
  }

  private fun smallIcon(): Int {
    val id = resources.getIdentifier("ic_pulse_notif", "drawable", packageName)
    return if (id != 0) id else androidx.media3.session.R.drawable.media3_icon_circular_play
  }
`],
  // уведомление — обычное системное, привязанное к нашей сессии, с тремя кнопками
  [`    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(androidx.media3.session.R.drawable.media3_icon_circular_play)
      .setContentTitle(currentMetadata?.title ?: "\\u200E")
      .setContentText(currentMetadata?.artist)
      .setSubText(currentMetadata?.albumTitle)
      .setLargeIcon(currentArtwork)
      .setContentIntent(buildContentIntent())
      .setAutoCancel(false)
      .setCategory(NotificationCompat.CATEGORY_TRANSPORT)

    // Using only session custom layout: do NOT call setShowActionsInCompactView.
    // The compact layout will follow the order of the custom layout provided to the session.
    builder.setStyle(MediaStyleNotificationHelper.MediaStyle(session))

    return builder.build()
`, `    if (session.player == null) return null
    updateFw()
    val pi = { action: String, code: Int -> PendingIntent.getService(this, code, Intent(this, AudioControlsService::class.java).setAction(action), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE) }
    val act = { icon: Int, title: String, action: String, code: Int -> Notification.Action.Builder(Icon.createWithResource(this, icon), title, pi(action, code)).build() }
    val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL_ID) else Notification.Builder(this)
    b.setSmallIcon(smallIcon())
      .setContentTitle(currentMetadata?.title ?: "\\u200E")
      .setContentText(currentMetadata?.artist)
      .setSubText(currentMetadata?.albumTitle)
      .setLargeIcon(currentArtwork)
      .setContentIntent(buildContentIntent())
      .setAutoCancel(false)
      .setOngoing(lastPlaying)
      .setShowWhen(false)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setCategory(Notification.CATEGORY_TRANSPORT)
      .addAction(act(android.R.drawable.ic_media_previous, "Previous", ACTION_PREV, 11))
      .addAction(if (lastPlaying) act(android.R.drawable.ic_media_pause, "Pause", ACTION_TOGGLE, 12) else act(android.R.drawable.ic_media_play, "Play", ACTION_TOGGLE, 12))
      .addAction(act(android.R.drawable.ic_media_next, "Next", ACTION_NEXT, 13))
      .setStyle(Notification.MediaStyle().setMediaSession(fwSession().sessionToken).setShowActionsInCompactView(0, 1, 2))
    return b.build()
`],
  // состояние для системной сессии обновляем при каждом изменении игры и при перемотке
  ['      updateSessionCustomLayout(player.ref.isPlaying)\n', '      snap()\n      updateSessionCustomLayout(player.ref.isPlaying)\n'],
  ['        override fun onIsPlayingChanged(isPlaying: Boolean) {\n', '        override fun onIsPlayingChanged(isPlaying: Boolean) {\n          snap()\n'],
  ['        override fun onPlaybackStateChanged(playbackState: Int) {\n', `        override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
          snap()
          postOrStartForegroundNotification(startInForeground = false)
        }

        override fun onPlaybackStateChanged(playbackState: Int) {
          snap()
`],
  ['    mediaSession?.release()\n    mediaSession = null\n    stopForeground(STOP_FOREGROUND_REMOVE)\n', '    mediaSession?.release()\n    mediaSession = null\n    fw?.isActive = false\n    fw?.release()\n    fw = null\n    stopForeground(STOP_FOREGROUND_REMOVE)\n'],
]);
edit('service/AudioMediaSessionCallback.kt', [
  ['            .add(SessionCommand(AudioControlsService.ACTION_SEEK_FORWARD, Bundle.EMPTY))\n', '            .add(SessionCommand(AudioControlsService.ACTION_SEEK_FORWARD, Bundle.EMPTY))\n            .add(SessionCommand(AudioControlsService.ACTION_NEXT, Bundle.EMPTY))\n            .add(SessionCommand(AudioControlsService.ACTION_PREV, Bundle.EMPTY))\n'],
  ['      AudioControlsService.ACTION_SEEK_FORWARD -> {', '      AudioControlsService.ACTION_NEXT -> AudioControlsService.getInstance()?.remote("next")\n      AudioControlsService.ACTION_PREV -> AudioControlsService.getInstance()?.remote("prev")\n      AudioControlsService.ACTION_SEEK_FORWARD -> {'],
]);

// ВАЖНО: в Expo SDK 54 модули Android приходят уже собранными (готовый AAR из local-maven-repo), и правки
// исходников выше в APK не попадали. Просим собрать expo-audio из исходников — тогда доработки действуют.
{
  const pj = path.join(process.argv[2] || '.', 'package.json');
  const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
  j.expo = j.expo || {}; j.expo.autolinking = j.expo.autolinking || {}; j.expo.autolinking.android = j.expo.autolinking.android || {};
  const b = new Set(j.expo.autolinking.android.buildFromSource || []); b.add('expo-audio');
  j.expo.autolinking.android.buildFromSource = [...b];
  fs.writeFileSync(pj, JSON.stringify(j, null, 2));
  console.log('patch-expo-audio: expo-audio собирается из исходников');
}
