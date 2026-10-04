#!/usr/bin/env node

const services = [
  { name: 'IOWEN (国内)', url: 'https://api.iowen.cn/favicon/google.com.png' },
  { name: 'Favicon.im', url: 'https://favicon.im/google.com' },
  { name: 'Google', url: 'https://www.google.com/s2/favicons?domain=google.com&sz=32' },
  { name: 'DuckDuckGo', url: 'https://icons.duckduckgo.com/ip3/google.com.ico' },
  { name: 'Yandex', url: 'https://favicon.yandex.net/favicon/v2/google.com?size=32' },
  { name: 'Clearbit', url: 'https://logo.clearbit.com/google.com' },
];

async function checkService(service) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(service.url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    clearTimeout(timeout);

    if (response.ok) {
      const contentType = response.headers.get('content-type');
      const size = response.headers.get('content-length');
      console.log(`✓ ${service.name}: 可用 (${contentType}, ${size || 'unknown'} bytes)`);
      return true;
    } else {
      console.log(`✗ ${service.name}: HTTP ${response.status}`);
      return false;
    }
  } catch (error) {
    console.log(`✗ ${service.name}: ${error.message}`);
    return false;
  }
}

async function main() {
  console.log('测试 favicon 服务可用性...\n');

  const results = await Promise.all(services.map(checkService));

  console.log(`\n${results.filter(Boolean).length}/${services.length} 个服务可用`);

  if (results.every((r) => !r)) {
    console.log('\n所有外部服务均不可用，建议：');
    console.log('1. 检查网络连接/代理设置');
    console.log('2. 使用本地 favicon 缓存方案');
  }
}

main();
