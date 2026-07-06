(function () {
  var canvas = document.getElementById('ambientCanvas') || document.getElementById('bgCanvas');
  if (!canvas) return;

  var ctx = canvas.getContext('2d');
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var dpr = 1;
  var w = 0;
  var h = 0;
  var t = 0;
  var clouds = [];
  var wisps = [];
  var drift = [];

  var palettes = {
    dark: {
      base: ['#0a0a0a', '#14100e', '#1a120c', '#0d0d0d'],
      orange: ['rgba(255,77,0,', 'rgba(255,120,40,', 'rgba(255,160,80,'],
      white: ['rgba(255,255,255,', 'rgba(245,240,235,', 'rgba(220,215,210,'],
      black: ['rgba(0,0,0,', 'rgba(8,8,8,', 'rgba(16,12,10,'],
      vignette: 'rgba(0,0,0,0.35)'
    },
    light: {
      base: ['#F6F3EF', '#FFF8F2', '#F0EBE4', '#FAF7F4'],
      orange: ['rgba(255,77,0,', 'rgba(255,130,60,', 'rgba(255,170,100,'],
      white: ['rgba(255,255,255,', 'rgba(255,252,248,', 'rgba(250,245,240,'],
      black: ['rgba(30,28,26,', 'rgba(60,55,50,', 'rgba(90,80,70,'],
      vignette: 'rgba(255,255,255,0.2)'
    }
  };

  function theme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function rand(a, b) {
    return a + Math.random() * (b - a);
  }

  function makeCloud(seed) {
    var p = palettes[theme()];
    var layer = seed % 3;
    var palette = layer === 0 ? p.orange : layer === 1 ? p.white : p.black;
    var edge = Math.floor(Math.random() * 4);
    var x, y, vx, vy;
    var speed = layer === 2 ? rand(0.08, 0.22) : rand(0.15, 0.45);

    if (edge === 0) {
      x = rand(-0.15 * w, w * 1.15);
      y = -rand(0.1, 0.35) * h;
      vx = rand(-0.12, 0.12);
      vy = rand(0.08, 0.28);
    } else if (edge === 1) {
      x = w + rand(0.05, 0.2) * w;
      y = rand(-0.1 * h, h * 1.1);
      vx = -rand(0.1, 0.35);
      vy = rand(-0.08, 0.08);
    } else if (edge === 2) {
      x = rand(-0.15 * w, w * 1.15);
      y = h + rand(0.05, 0.2) * h;
      vx = rand(-0.1, 0.1);
      vy = -rand(0.08, 0.25);
    } else {
      x = -rand(0.1, 0.3) * w;
      y = rand(-0.1 * h, h * 1.1);
      vx = rand(0.1, 0.35);
      vy = rand(-0.06, 0.06);
    }

    return {
      x: x,
      y: y,
      r: rand(80, layer === 0 ? 320 : 260) * (0.7 + layer * 0.15),
      vx: vx * speed,
      vy: vy * speed,
      color: pick(palette),
      alpha: rand(0.04, layer === 0 ? 0.18 : 0.12),
      layer: layer,
      rot: rand(0, Math.PI * 2),
      rotSpd: rand(-0.0004, 0.0004),
      squash: rand(0.65, 1.35)
    };
  }

  function makeWisp() {
    var p = palettes[theme()];
    return {
      x: rand(-0.1 * w, w * 1.1),
      y: rand(0, h),
      len: rand(120, 420),
      angle: rand(-0.4, 0.4),
      speed: rand(0.2, 0.7),
      alpha: rand(0.02, 0.07),
      color: Math.random() > 0.5 ? pick(p.white) : pick(p.orange)
    };
  }

  function makeDrift() {
    var p = palettes[theme()];
    return {
      x: rand(0, w),
      y: rand(0, h),
      r: rand(3, 8),
      vx: rand(-0.3, 0.3),
      vy: rand(-0.25, 0.25),
      color: pick(p.orange),
      alpha: rand(0.15, 0.45),
      pulse: rand(0, Math.PI * 2)
    };
  }

  function rebuild() {
    clouds = [];
    wisps = [];
    drift = [];
    var count = Math.min(18, Math.max(10, Math.floor((w * h) / 55000)));
    for (var i = 0; i < count; i++) clouds.push(makeCloud(i));
    for (var j = 0; j < 8; j++) wisps.push(makeWisp());
    for (var k = 0; k < 14; k++) drift.push(makeDrift());
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rebuild();
  }

  function drawBase() {
    var p = palettes[theme()];
    var g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, p.base[0]);
    g.addColorStop(0.35, p.base[1]);
    g.addColorStop(0.65, p.base[2]);
    g.addColorStop(1, p.base[3]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    if (!reduce) {
      var og = ctx.createRadialGradient(w * 0.82, h * 0.12, 0, w * 0.82, h * 0.12, w * 0.55);
      og.addColorStop(0, p.orange[0] + '0.14)');
      og.addColorStop(1, p.orange[0] + '0)');
      ctx.fillStyle = og;
      ctx.fillRect(0, 0, w, h);

      var wg = ctx.createRadialGradient(w * 0.12, h * 0.88, 0, w * 0.12, h * 0.88, w * 0.45);
      wg.addColorStop(0, p.white[0] + '0.08)');
      wg.addColorStop(1, p.white[0] + '0)');
      ctx.fillStyle = wg;
      ctx.fillRect(0, 0, w, h);
    }
  }

  function drawCloud(c) {
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.rot);
    ctx.scale(c.squash, 1 / c.squash);
    var g = ctx.createRadialGradient(0, 0, 0, 0, 0, c.r);
    g.addColorStop(0, c.color + c.alpha + ')');
    g.addColorStop(0.45, c.color + (c.alpha * 0.55) + ')');
    g.addColorStop(1, c.color + '0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, c.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function tickClouds() {
    if (reduce) return;
    clouds.sort(function (a, b) {
      return a.layer - b.layer;
    });
    clouds.forEach(function (c) {
      c.x += c.vx;
      c.y += c.vy;
      c.rot += c.rotSpd;
      if (c.x < -c.r * 1.4 || c.x > w + c.r * 1.4 || c.y < -c.r * 1.4 || c.y > h + c.r * 1.4) {
        var fresh = makeCloud(Math.floor(Math.random() * 3));
        c.x = fresh.x;
        c.y = fresh.y;
        c.vx = fresh.vx;
        c.vy = fresh.vy;
        c.r = fresh.r;
        c.color = fresh.color;
        c.alpha = fresh.alpha;
        c.layer = fresh.layer;
      }
      drawCloud(c);
    });
  }

  function tickWisps() {
    wisps.forEach(function (s) {
      if (!reduce) {
        s.x += Math.cos(s.angle) * s.speed;
        s.y += Math.sin(s.angle) * s.speed * 0.4;
        if (s.x < -s.len || s.x > w + s.len) {
          var n = makeWisp();
          s.x = n.x;
          s.y = n.y;
          s.angle = n.angle;
        }
      }
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.angle);
      var g = ctx.createLinearGradient(0, 0, s.len, 0);
      g.addColorStop(0, s.color + '0)');
      g.addColorStop(0.35, s.color + s.alpha + ')');
      g.addColorStop(0.65, s.color + (s.alpha * 0.6) + ')');
      g.addColorStop(1, s.color + '0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, -1.5, s.len, 3);
      ctx.restore();
    });
  }

  function tickDrift() {
    drift.forEach(function (d) {
      if (!reduce) {
        d.x += d.vx;
        d.y += d.vy;
        d.pulse += 0.03;
        if (d.x < -20 || d.x > w + 20 || d.y < -20 || d.y > h + 20) {
          var n = makeDrift();
          d.x = n.x;
          d.y = n.y;
          d.vx = n.vx;
          d.vy = n.vy;
        }
      }
      var a = d.alpha * (0.65 + 0.35 * Math.sin(d.pulse));
      var g = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, d.r * 3);
      g.addColorStop(0, d.color + a + ')');
      g.addColorStop(1, d.color + '0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r * 3, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function vignette() {
    var p = palettes[theme()];
    var v = ctx.createRadialGradient(w / 2, h / 2, w * 0.2, w / 2, h / 2, w * 0.85);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, p.vignette);
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, w, h);
  }

  function frame() {
    t += 0.005;
    drawBase();
    tickClouds();
    tickWisps();
    tickDrift();
    vignette();
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize);
  window.addEventListener('quorix-theme-change', function () {
    rebuild();
  });
  resize();
  frame();
})();