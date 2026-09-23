import { Module } from '@nestjs/common';
import { LoginSessionsController } from './login-sessions.controller';
import { LoginSessionsService } from './login-sessions.service';

@Module({
  controllers: [LoginSessionsController],
  providers: [LoginSessionsService],
})
export class LoginSessionsModule {}
