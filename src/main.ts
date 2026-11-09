import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

export async function createApp() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableCors();
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('SiteTrack API')
    .setDescription(
      'Backend for SiteTrack: projects, tasks, dependencies, members, materials and deliveries. ' +
        'Authenticate with POST /auth/login, send `Authorization: Bearer <accessToken>`, and refresh with POST /auth/refresh. ' +
        'See docs/API.md for response shapes and business rules.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);
  return { app, document };
}

async function bootstrap() {
  const { app } = await createApp();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  console.log(`SiteTrack API listening on :${port} (docs at /docs)`);
}

if (require.main === module) {
  void bootstrap();
}
