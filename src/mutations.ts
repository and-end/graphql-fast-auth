import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import * as validator from 'validator';
import * as uuidv4 from 'uuid/v4';
import { getUser, Context } from './utils';
import { User, UserUpdateInput } from './generated/prisma';
import {
  MissingDataError,
  ResetTokenExpiredError,
  InvalidEmailError,
  PasswordTooShortError,
  UserNotFoundError,
  InvalidInviteTokenError,
  UserEmailExistsError,
  UserInviteNotAcceptedError,
  UserDeletedError,
  InvalidOldPasswordError,
  InvalidEmailConfirmToken,
  UserEmailUnconfirmedError
} from './errors';

function generateToken(user: User, ctx: Context) {
  return jwt.sign({ userId: user.id }, ctx.graphqlUser.secret);
}

function validatePassword(value: string) {
  if (value.length <= 8) {
    throw new PasswordTooShortError();
  }
}

function getHashedPassword(value: string) {
  return bcrypt.hash(value, 10);
}

export const mutations = {
  async signupByInvite(parent: any, { data }: { data: User }, ctx: Context) {
    // Important first check, because i.e. the `inviteToken` could be an empty string
    // and in that case the find query beneath would find any user with any given email,
    // allowing you to change the password of everybody.
    if (!data.inviteToken || !data.email) {
      throw new MissingDataError();
    }
    const user = await ctx.graphqlUser.adapter.findUserByEmail(ctx, data.email);
    if (!user) {
      throw new UserNotFoundError();
    }
    if (user.inviteToken !== data.inviteToken || user.inviteAccepted) {
      throw new InvalidInviteTokenError();
    }

    validatePassword(data.password);
    const hashedPassword = await getHashedPassword(data.password);

    const updatedUser = await ctx.graphqlUser.adapter.updateUserCompleteInvite(
      ctx,
      user.id,
      {
        name: data.name,
        inviteToken: '',
        inviteAccepted: true,
        password: hashedPassword
      }
    );

    return {
      token: generateToken(user, ctx),
      user: updatedUser
    };
  },

  async signup(parent: any, { data }: { data: User }, ctx: Context) {
    if (!data.email) {
      throw new MissingDataError();
    }
    const userExists = await ctx.graphqlUser.adapter.userExistsByEmail(
      ctx,
      data.email
    );
    if (userExists) {
      throw new UserEmailExistsError();
    }

    validatePassword(data.password);
    const hashedPassword = await getHashedPassword(data.password);
    const emailConfirmToken = uuidv4();

    const newUser = await ctx.graphqlUser.adapter.createUserBySignup(ctx, {
      name: data.name,
      email: data.email,
      password: hashedPassword,
      emailConfirmToken,
      emailConfirmed: false,
      joinedAt: new Date().toISOString()
    });

    if (ctx.graphqlUser.mailer) {
      ctx.graphqlUser.mailer.send({
        template: 'signupUser',
        message: {
          to: newUser.email
        },
        locals: {
          mailAppUrl: ctx.graphqlUser.mailAppUrl,
          emailConfirmToken,
          email: newUser.email
        }
      });
    }

    return {
      token: generateToken(newUser, ctx),
      user: newUser
    };
  },

  async confirmEmail(
    parent: any,
    { emailConfirmToken, email }: { emailConfirmToken: string; email: string },
    ctx: Context
  ) {
    if (!emailConfirmToken || !email) {
      throw new MissingDataError();
    }
    const user = await ctx.graphqlUser.adapter.findUserByEmail(ctx, email);
    if (!user) {
      throw new UserNotFoundError();
    }
    if (user.emailConfirmToken !== emailConfirmToken || user.emailConfirmed) {
      throw new InvalidEmailConfirmToken();
    }

    const updatedUser = await ctx.graphqlUser.adapter.updateUserConfirmToken(
      ctx,
      user.id,
      {
        emailConfirmToken: '',
        emailConfirmed: true
      }
    );

    return {
      token: generateToken(user, ctx),
      user: updatedUser
    };
  },

  async login(parent: any, { email, password }: User, ctx: Context) {
    const user = await ctx.graphqlUser.adapter.findUserByEmail(ctx, email);
    if (!user) {
      throw new UserNotFoundError();
    }

    if (!user.inviteAccepted) {
      throw new UserInviteNotAcceptedError();
    }

    if (user.deletedAt) {
      throw new UserDeletedError();
    }

    if (
      ctx.graphqlUser.requiredConfirmedEmailForLogin &&
      !user.emailConfirmed
    ) {
      throw new UserEmailUnconfirmedError();
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      throw new UserNotFoundError();
    }

    // Purposefully async, this update doesn't matter that much.
    ctx.graphqlUser.adapter.updateUserLastLogin(ctx, user.id, {
      lastLogin: new Date().toISOString()
    });

    return {
      token: generateToken(user, ctx),
      user
    };
  },

  async changePassword(
    parent: any,
    { oldPassword, newPassword }: { oldPassword: string; newPassword: string },
    ctx: Context
  ) {
    const user = await getUser(ctx);

    const valid = await bcrypt.compare(user.password, oldPassword);
    if (!valid) {
      throw new InvalidOldPasswordError();
    }

    validatePassword(newPassword);
    const password = await getHashedPassword(newPassword);

    const newUser = await ctx.graphqlUser.adapter.updateUserPassword(
      ctx,
      user.id,
      { password }
    );

    return {
      id: newUser!.id
    };
  },

  async inviteUser(
    parent: any,
    {
      data
    }: {
      data: {
        email: string;
      };
    },
    ctx: Context
  ) {
    await getUser(ctx);

    if (!validator.isEmail(data.email)) {
      throw new InvalidEmailError();
    }

    const existingUser = await ctx.graphqlUser.adapter.findUserByEmail(
      ctx,
      data.email
    );
    if (existingUser) {
      if (ctx.graphqlUser.hookInviteUserPostCreate) {
        await ctx.graphqlUser.hookInviteUserPostCreate(data, ctx, existingUser);
      }
      return {
        id: existingUser.id
      };
    }

    // This token will be used in the email to the user.
    // According to https://gist.github.com/joepie91/7105003c3b26e65efcea63f3db82dfba
    // uuid v4 is safe to be used as random token generator.
    const inviteToken = uuidv4();

    const newUser = await ctx.graphqlUser.adapter.createUserByInvite(ctx, {
      email: data.email,
      inviteToken,
      inviteAccepted: false,
      password: '',
      name: '',
      joinedAt: new Date().toISOString()
    });

    if (ctx.graphqlUser.hookInviteUserPostCreate) {
      await ctx.graphqlUser.hookInviteUserPostCreate(data, ctx, newUser);
    }

    if (ctx.graphqlUser.mailer) {
      ctx.graphqlUser.mailer.send({
        template: 'inviteUser',
        message: {
          to: newUser.email
        },
        locals: {
          mailAppUrl: ctx.graphqlUser.mailAppUrl,
          inviteToken,
          email: newUser.email
        }
      });
    }

    return {
      id: newUser.id
    };
  },

  async triggerPasswordReset(parent: any, { email }: User, ctx: Context) {
    if (!validator.isEmail(email)) {
      throw new InvalidEmailError();
    }

    const user = await ctx.graphqlUser.adapter.findUserByEmail(ctx, email);
    if (!user) {
      return { ok: true };
    }

    // This token will be used in the email to the user.
    // According to https://gist.github.com/joepie91/7105003c3b26e65efcea63f3db82dfba
    // uuid v4 is safe to be used as random token generator.
    const resetToken = uuidv4();
    const now = new Date();
    // Expires in two hours
    const resetExpires = new Date(now.getTime() + 7200000).toISOString();

    await ctx.graphqlUser.adapter.updateUserResetToken(ctx, user.id, {
      resetToken,
      resetExpires
    });

    if (ctx.graphqlUser.mailer) {
      ctx.graphqlUser.mailer.send({
        template: 'passwordReset',
        message: {
          to: user.email
        },
        locals: { mailAppUrl: ctx.graphqlUser.mailAppUrl, resetToken, email }
      });
    }

    return {
      ok: true
    };
  },

  async passwordReset(
    parent: any,
    { email, resetToken, password }: User,
    ctx: Context
  ) {
    if (!resetToken || !password) {
      throw new MissingDataError();
    }
    const user = await ctx.graphqlUser.adapter.findUserByEmail(ctx, email);
    if (!user || !user.resetExpires || user.resetToken !== resetToken) {
      throw new UserNotFoundError();
    }
    if (new Date() > new Date(user.resetExpires)) {
      throw new ResetTokenExpiredError();
    }

    validatePassword(password);
    const hashedPassword = await getHashedPassword(password);

    await ctx.graphqlUser.adapter.updateUserResetToken(ctx, user.id, {
      resetToken: '',
      resetExpires: undefined
    });
    await ctx.graphqlUser.adapter.updateUserPassword(ctx, user.id, {
      password: hashedPassword
    });

    return {
      id: user.id
    };
  },

  async updateCurrentUser(
    parent: any,
    { data }: { data: UserUpdateInput },
    ctx: Context
  ) {
    const user = await getUser(ctx);

    await ctx.graphqlUser.adapter.updateUserInfo(ctx, user.id, data);

    return user;
  }
};
