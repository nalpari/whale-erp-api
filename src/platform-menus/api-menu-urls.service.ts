import { Injectable } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService } from '@nestjs/core';
import { MENU_PERMISSION, menuUrlOf } from '../auth/menu-permission.guard';

/** 클래스와 프로토타입 체인의 메서드에 단 `@MenuPermission` 표시들. */
function marksOf(cls: abstract new (...args: never[]) => unknown): unknown[] {
  const marks: unknown[] = [Reflect.getMetadata(MENU_PERMISSION, cls)];
  for (
    let proto: object | null = cls.prototype as object;
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto) as object | null
  )
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const value: unknown = Object.getOwnPropertyDescriptor(
        proto,
        name,
      )?.value;
      if (typeof value === 'function')
        marks.push(Reflect.getMetadata(MENU_PERMISSION, value));
    }
  return marks;
}

/** 메뉴 코드 없이 경로로 메뉴를 찾는 표시 — 가드와 같이 'menuCode' 키가 있는지로 가른다. */
const isPathMark = (mark: unknown): boolean =>
  typeof mark === 'object' && mark !== null && !('menuCode' in mark);

/**
 * API 권한 주소 — 클래스나 어느 메서드에든 경로 방식 `@MenuPermission` 표시가 있는 컨트롤러의 경로 첫 단계
 * (`'/' + 첫 단계`). 가드의 `menuUrlOf` 와 같은 규칙이라, 이 집합의 메뉴 URL 이 곧 그 API 의 권한 키다.
 * 경로로 메뉴를 못 정하는 컨트롤러(경로 없음 · `'/'` · 배열)는 가드가 어차피 403 이라 빠진다.
 */
export function collectApiMenuUrls(
  classes: readonly unknown[],
): ReadonlySet<string> {
  const urls = new Set<string>();
  for (const cls of classes) {
    if (typeof cls !== 'function') continue;
    const ctor = cls as abstract new (...args: never[]) => unknown;
    if (!marksOf(ctor).some(isPathMark)) continue;
    const url = menuUrlOf(Reflect.getMetadata(PATH_METADATA, ctor) as unknown);
    if (url) urls.add(url);
  }
  return urls;
}

/**
 * 앱에 등록된 컨트롤러에서 모은 API 권한 주소. 플랫폼 메뉴 관리가 이 주소를 가진 메뉴의 URL 을 바꾸거나 다른 메뉴가
 * 가져가지 못하게 하는 데 쓴다. 컨트롤러는 앱이 뜬 뒤 바뀌지 않으므로 처음 물을 때 한 번만 모은다 — 모듈 초기화
 * 순서에 기대지 않으려고 onModuleInit 대신 지연해서 모은다.
 */
@Injectable()
export class ApiMenuUrlsService {
  private urls?: ReadonlySet<string>;

  constructor(private readonly discovery: DiscoveryService) {}

  all(): ReadonlySet<string> {
    this.urls ??= collectApiMenuUrls(
      this.discovery.getControllers().map((wrapper) => wrapper.metatype),
    );
    return this.urls;
  }

  has(url: string): boolean {
    return this.all().has(url);
  }
}
