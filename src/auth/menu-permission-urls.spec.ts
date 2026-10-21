import { PATH_METADATA } from '@nestjs/common/constants';
import { CodeGroupsController } from '../code-groups/code-groups.controller';
import { ContractSendController } from '../contracts/contract-send.controller';
import { ContractsController } from '../contracts/contracts.controller';
import { InquiriesController } from '../inquiries/inquiries.controller';
import { SupportInquiriesController } from '../inquiries/support-inquiries.controller';
import { LeadsAdminController } from '../leads/leads-admin.controller';
import { PlatformAdminsController } from '../platform-admins/platform-admins.controller';
import { collectApiMenuUrls } from '../platform-menus/api-menu-urls.service';
import { PlatformMenusController } from '../platform-menus/platform-menus.controller';
import { PayslipsController } from '../payslips/payslips.controller';
import { PlatformRoleGroupsController } from '../platform-role-groups/platform-role-groups.controller';
import {
  PlatformFaqsController,
  PlatformNoticesController,
} from '../posts/posts.controller';
import {
  SupportFaqsController,
  SupportNoticesController,
} from '../posts/support-posts.controller';
import { RetirementController } from '../staff-members/retirement.controller';
import { StaffMembersController } from '../staff-members/staff-members.controller';
import { StoresController } from '../stores/stores.controller';
import { StaffMemberTodosController } from '../todos/staff-member-todos.controller';
import { TodosController } from '../todos/todos.controller';
import { WorkSchedulesController } from '../work-schedules/work-schedules.controller';
import { menuUrlOf } from './menu-permission.guard';
import { PasswordResetLinkAdminController } from './password-reset-link-admin.controller';

/**
 * 경로 방식 `@MenuPermission` 컨트롤러가 어느 메뉴로 판정되는지 — 컨트롤러 경로를 바꾸면 그 API 가 다른 메뉴(또는
 * 없는 메뉴, 모두 403)로 판정되므로, 바꾼 사람이 이 표와 메뉴 URL 마이그레이션을 함께 고치게 한다.
 *
 * 오른쪽 값은 마이그레이션이 넣은 menus.url 이다:
 * - `/stores`(MN000002) — 20261006000100_team1_initial_data
 * - `/staff-members`(MN000005) · `/contracts`(MN000006) · `/payslips`(MN000009) · `/work-schedules`(MN000010) ·
 *   `/todos`(MN000026)
 *   — 20261015110333_team3_menu_single_level_urls
 * - `/support-notices`(MN000035) · `/support-faqs`(MN000043) · `/support-inquiries`(MN000036)
 *   — 20261015150000_team3_support_menu_split
 * - `/platform-admins`(MN000213) · `/platform-role-groups`(MN000214) · `/platform-menus`(MN000215) ·
 *   `/code-groups`(MN000216) — 20261019144438_team1_menu_single_level_urls
 * - `/platform-notices`(MN000219) · `/platform-faqs`(MN000220) · `/platform-inquiries`(MN000221) ·
 *   `/platform-leads`(MN000222) — 20261020161147_team3_community_menu_single_level_urls
 */
const EXPECTED: [string, abstract new (...args: never[]) => unknown, string][] =
  [
    ['StoresController', StoresController, '/stores'],
    ['PlatformAdminsController', PlatformAdminsController, '/platform-admins'],
    [
      'PlatformRoleGroupsController',
      PlatformRoleGroupsController,
      '/platform-role-groups',
    ],
    ['PlatformMenusController', PlatformMenusController, '/platform-menus'],
    ['CodeGroupsController', CodeGroupsController, '/code-groups'],
    ['StaffMembersController', StaffMembersController, '/staff-members'],
    ['RetirementController', RetirementController, '/staff-members'],
    [
      'PasswordResetLinkAdminController',
      PasswordResetLinkAdminController,
      '/staff-members',
    ],
    [
      'StaffMemberTodosController',
      StaffMemberTodosController,
      '/staff-members',
    ],
    ['PayslipsController', PayslipsController, '/payslips'],
    ['ContractsController', ContractsController, '/contracts'],
    ['ContractSendController', ContractSendController, '/contracts'],
    ['TodosController', TodosController, '/todos'],
    ['WorkSchedulesController', WorkSchedulesController, '/work-schedules'],
    [
      'SupportInquiriesController',
      SupportInquiriesController,
      '/support-inquiries',
    ],
    ['InquiriesController', InquiriesController, '/platform-inquiries'],
    ['LeadsAdminController', LeadsAdminController, '/platform-leads'],
    [
      'PlatformNoticesController',
      PlatformNoticesController,
      '/platform-notices',
    ],
    ['PlatformFaqsController', PlatformFaqsController, '/platform-faqs'],
    ['SupportNoticesController', SupportNoticesController, '/support-notices'],
    ['SupportFaqsController', SupportFaqsController, '/support-faqs'],
  ];

describe('컨트롤러 경로 ↔ 메뉴 URL 대응', () => {
  it.each(EXPECTED)('%s 는 메뉴 %p 로 판정된다', (_name, cls, url) => {
    expect(menuUrlOf(Reflect.getMetadata(PATH_METADATA, cls) as unknown)).toBe(
      url,
    );
  });

  // 표의 컨트롤러가 모두 경로 방식이어야 API 권한 주소에 들어가 메뉴 관리에서 URL 이 고정된다.
  it('표의 컨트롤러는 모두 API 권한 주소로 모인다', () => {
    expect(collectApiMenuUrls(EXPECTED.map(([, cls]) => cls))).toEqual(
      new Set(EXPECTED.map(([, , url]) => url)),
    );
  });
});
