import { Module } from '@nestjs/common';
import { AccessTokenService } from './access-token.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginRateLimitGuard } from './login-rate-limit.guard';

@Module({
  controllers: [AuthController],
  providers: [AccessTokenService, AuthService, LoginRateLimitGuard],
  exports: [AccessTokenService],
})
export class AuthModule {}
