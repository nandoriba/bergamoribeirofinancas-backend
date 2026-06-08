import { PartialType } from '@nestjs/mapped-types';

import { CreateRecurringDto } from './create-recurring.dto';

export class UpdateRecurringDto extends PartialType(CreateRecurringDto) {}

