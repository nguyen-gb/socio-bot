import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { FacebookController } from './facebook.controller';
import { FacebookService } from './facebook.service';

@Module({ imports: [TasksModule], controllers: [FacebookController], providers: [FacebookService] })
export class FacebookModule {}
