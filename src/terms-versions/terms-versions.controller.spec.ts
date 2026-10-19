import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { IS_PUBLIC } from '../auth/auth.decorators';
import { TermsVersionsController } from './terms-versions.controller';
import { TermsVersionsService } from './terms-versions.service';

describe('TermsVersionsController', () => {
  let controller: TermsVersionsController;
  let service: { findAll: jest.Mock; findOne: jest.Mock };

  beforeEach(async () => {
    service = { findAll: jest.fn(), findOne: jest.fn() };
    const module = await Test.createTestingModule({
      controllers: [TermsVersionsController],
      providers: [{ provide: TermsVersionsService, useValue: service }],
    }).compile();
    controller = module.get(TermsVersionsController);
  });

  it('로그인 없이 부른다', () => {
    expect(
      new Reflector().get(IS_PUBLIC, TermsVersionsController),
    ).toBeTruthy();
  });

  it('목록은 서비스 결과 그대로', async () => {
    service.findAll.mockResolvedValue({ items: [], total: 0 });
    expect(await controller.findAll()).toEqual({ items: [], total: 0 });
  });

  it('없는 유형은 404', async () => {
    service.findOne.mockResolvedValue(null);
    await expect(controller.findOne('POLICY')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(service.findOne).toHaveBeenCalledWith('POLICY');
  });
});
