/**
 * web_timestamp.js
 * 小宇宙官网单集页 ?t=<秒> 深链定位脚本（manifest content_scripts 注入
 * https://www.xiaoyuzhoufm.com/episode/*）。
 *
 * 官网本身不处理 t 参数；本脚本在音频元数据加载或首次播放时，
 * 把播放器定位到目标秒数（供转写稿 / AI 总结中的时间戳深链跳转）。
 * 若用户播放进度已超过目标位置，则不回拉。
 */
(() => {
  const match = location.search.match(/[?&]t=(\d+(?:\.\d+)?)\b/);
  if (!match) return;
  const target = Number.parseFloat(match[1]);
  if (!Number.isFinite(target) || target <= 0) return;

  let done = false;

  const seek = (audio) => {
    if (done || !audio) return;
    if (audio.readyState < 1) return; // 元数据未就绪，等下次机会
    if (audio.currentTime >= target) {
      done = true;
      return; // 已越过目标位置，不打扰用户
    }
    try {
      audio.currentTime = target;
      done = true;
    } catch {
      // 元数据未完全就绪时设置会抛错，交给下轮扫描
    }
  };

  const scan = () => {
    if (done) return;
    for (const audio of document.querySelectorAll('audio')) {
      seek(audio);
      if (done) return;
    }
    setTimeout(scan, 500);
  };

  // 部分页面要等开始播放才加载元数据，首次播放时再试一次
  document.addEventListener(
    'play',
    (e) => {
      if (e.target instanceof HTMLAudioElement) seek(e.target);
    },
    true
  );

  scan();
})();
