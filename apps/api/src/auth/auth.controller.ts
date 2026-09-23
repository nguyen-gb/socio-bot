import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { loginSchema, refreshTokenSchema, type LoginInput, type RefreshTokenInput } from '@socio/contracts';
import { Public } from '../common/public.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AuthenticatedRequest } from './auth.types';
import { AuthService } from './auth.service';
import { LoginRateLimitGuard } from './login-rate-limit.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @UseGuards(LoginRateLimitGuard)
  login(@Body(new ZodValidationPipe(loginSchema)) input: LoginInput) {
    return this.auth.login(input);
  }

  @Public()
  @Post('refresh')
  refresh(@Body(new ZodValidationPipe(refreshTokenSchema)) input: RefreshTokenInput) {
    return this.auth.refresh(input.refreshToken);
  }

  @Public()
  @Post('logout')
  async logout(@Body(new ZodValidationPipe(refreshTokenSchema)) input: RefreshTokenInput) {
    await this.auth.logout(input.refreshToken);
    return { ok: true };
  }

  @Get('me')
  me(@Req() request: AuthenticatedRequest) {
    return request.principal;
  }
}
