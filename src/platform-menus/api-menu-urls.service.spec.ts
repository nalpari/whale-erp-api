import { Controller, Get, SetMetadata } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { MENU_PERMISSION, MenuPermission } from '../auth/menu-permission.guard';
import {
  ApiMenuUrlsService,
  collectApiMenuUrls,
} from './api-menu-urls.service';

@Controller('stores')
class ClassMarked {}
MenuPermission('read')(ClassMarked);

@Controller('/todos/sub')
class MethodMarked {
  @Get()
  @MenuPermission('read')
  list() {}
}

@Controller('platform-x')
class CodeMarked {
  @Get()
  @MenuPermission('MN000010', 'read')
  list() {}
}

@Controller('mixed')
class Mixed {
  @Get('a')
  @MenuPermission('MN000010', 'read')
  a() {}

  @Get('b')
  @MenuPermission('update')
  b() {}
}

@Controller('plain')
class Unmarked {
  @Get()
  list() {}
}

// 메서드 표시만 상위 클래스에 있고 하위 클래스가 경로를 가진 꼴 — 가드는 하위 클래스로 판정한다.
class BaseWithMark {
  @MenuPermission('read')
  list() {}
}
@Controller('inherited')
class Inherited extends BaseWithMark {}

@Controller()
class RootPath {
  @MenuPermission('read')
  list() {}
}

@Controller('empty-code')
class EmptyCodeKey {
  @SetMetadata(MENU_PERMISSION, { menuCode: undefined, action: 'read' })
  list() {}
}

describe('collectApiMenuUrls — 경로 방식 @MenuPermission 컨트롤러의 경로 첫 단계', () => {
  it('클래스나 메서드에 경로 방식 표시가 있는 컨트롤러만 모은다', () => {
    expect(
      collectApiMenuUrls([
        ClassMarked,
        MethodMarked,
        CodeMarked,
        Mixed,
        Unmarked,
        Inherited,
      ]),
    ).toEqual(new Set(['/stores', '/todos', '/mixed', '/inherited']));
  });

  it('메뉴 코드 방식만 쓰거나 표시가 없는 컨트롤러는 빠진다', () => {
    expect(collectApiMenuUrls([CodeMarked, Unmarked])).toEqual(new Set());
  });

  it("경로로 메뉴를 못 정하는 컨트롤러(@Controller() 의 '/')는 빠진다 — 가드가 어차피 403 이다", () => {
    expect(collectApiMenuUrls([RootPath])).toEqual(new Set());
  });

  it('menuCode 키가 있는 표시는 값이 비어도 메뉴 코드 방식이다 — 가드와 같은 판정', () => {
    expect(collectApiMenuUrls([EmptyCodeKey])).toEqual(new Set());
  });
});

describe('ApiMenuUrlsService', () => {
  const discoveryOf = (classes: unknown[]) => {
    const getControllers = jest.fn(() =>
      classes.map((metatype) => ({ metatype })),
    );
    return {
      discovery: { getControllers } as unknown as DiscoveryService,
      getControllers,
    };
  };

  it('DiscoveryService 의 컨트롤러에서 한 번만 모은다', () => {
    const { discovery, getControllers } = discoveryOf([
      ClassMarked,
      CodeMarked,
      undefined,
    ]);
    const urls = new ApiMenuUrlsService(discovery);
    expect(urls.has('/stores')).toBe(true);
    expect(urls.has('/platform-x')).toBe(false);
    expect(urls.has('/todos')).toBe(false);
    expect(urls.all()).toEqual(new Set(['/stores']));
    expect(getControllers).toHaveBeenCalledTimes(1);
  });
});
