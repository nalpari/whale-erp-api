import { Module } from '@nestjs/common';
import { personalDataKeyProvider } from '../common/personal-data-key.provider';
import { MyMembershipsController } from './my-memberships.controller';
import { MyMembershipsService } from './my-memberships.service';
import { MyProfileController } from './my-profile.controller';
import { MyProfileService } from './my-profile.service';

@Module({
  controllers: [MyProfileController, MyMembershipsController],
  providers: [MyProfileService, MyMembershipsService, personalDataKeyProvider],
})
export class MyProfileModule {}
