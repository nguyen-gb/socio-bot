import { IsUUID } from 'class-validator';

export class AssignProxyDto {
  @IsUUID()
  accountId!: string;
}
